import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TOOL_RISK_REGISTRY,
  evaluateToolAction,
  exactToolApproval,
  toolArgumentsHash,
} from "../electron/tool-policy.ts";
import {
  JsonToolCallJournal,
  ReconciliationRequiredError,
  ToolDispatcher,
  type ToolCallRecord,
  type ToolCallStatus,
} from "../electron/tool-dispatch.ts";

test("risk registry is closed and the final guard defeats extension approval", () => {
  const maliciousAllow = () => "allow" as const;
  for (const actionId of ["codex.command_escalation", "codex.permission_escalation", "programmatic_tool_calls"]) {
    assert.equal(TOOL_RISK_REGISTRY[actionId]?.risk, "privileged");
    assert.equal(evaluateToolAction({ actionId, args: {}, extensions: [maliciousAllow] }).decision, "deny");
    assert.equal(evaluateToolAction({ actionId, args: {}, extensions: [maliciousAllow] }).reason, "final-guard-denied");
  }
  assert.equal(
    evaluateToolAction({ actionId: "plugin.unreviewed_write", args: {}, extensions: [maliciousAllow] }).decision,
    "deny",
  );
  assert.equal(
    evaluateToolAction({ actionId: "plugin.unreviewed_write", args: {}, extensions: [maliciousAllow] }).reason,
    "unregistered-tool",
  );
});

test("write approval is bound to task, exact action, canonical arguments, and expiry", () => {
  const now = new Date("2026-09-24T10:00:00.000Z");
  const args = { repo: "owner/repo", number: 9, body: "Approved text" };
  const scope = exactToolApproval("task-1", "github.comment_issue", args, "2026-09-24T10:01:00.000Z");
  assert.equal(toolArgumentsHash({ body: "Approved text", number: 9, repo: "owner/repo" }), scope.argsHash);
  assert.equal(evaluateToolAction({ actionId: "github.comment_issue", args, taskId: "task-1", approvalScope: scope, now }).decision, "allow");

  for (const input of [
    { taskId: "task-2", actionId: "github.comment_issue", args },
    { taskId: "task-1", actionId: "github.create_issue", args },
    { taskId: "task-1", actionId: "github.comment_issue", args: { ...args, body: "Different text" } },
  ]) {
    assert.equal(evaluateToolAction({ ...input, approvalScope: scope, now }).decision, "ask");
  }
  assert.equal(evaluateToolAction({ actionId: "github.comment_issue", args, taskId: "task-1", approvalScope: scope, now: new Date("2026-09-24T10:01:00.000Z") }).decision, "ask");
  assert.equal(evaluateToolAction({ actionId: "github.comment_issue", args, taskId: "task-1", approvalScope: scope, now, extensions: [() => "deny"] }).decision, "deny");
  assert.equal(evaluateToolAction({ actionId: "fixture.read", args, extensions: [() => "ask"] }).decision, "ask");
});

function call(overrides: Partial<Parameters<ToolDispatcher["execute"]>[0]> = {}) {
  return {
    key: "task-1:github.comment_issue:call-1",
    actionId: "github.comment_issue",
    argsHash: toolArgumentsHash({ body: "safe" }),
    sideEffect: true,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    run: async () => "posted",
    ...overrides,
  };
}

test("side effects require a durable journal and duplicate same-key calls are single-flight", async (context) => {
  const unjournaled = new ToolDispatcher();
  await assert.rejects(unjournaled.execute(call()), /durable call journal/);

  const directory = await mkdtemp(join(tmpdir(), "bmo-tool-journal-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const journal = new JsonToolCallJournal(join(directory, "calls.json"));
  let calls = 0;
  let release!: (value: string) => void;
  const pending = new Promise<string>((resolve) => { release = resolve; });
  const dispatcher = new ToolDispatcher(journal);
  const request = call({ run: async () => { calls += 1; return pending; } });
  const first = dispatcher.execute(request);
  const second = dispatcher.execute(request);
  await assert.rejects(dispatcher.execute(call({ key: request.key, argsHash: "different-hash" })), /reused for a different action or arguments/);
  await new Promise((resolve) => setImmediate(resolve));
  release("posted");
  assert.deepEqual(await Promise.all([first, second]), ["posted", "posted"]);
  assert.equal(calls, 1);
  await assert.rejects(dispatcher.execute(call({ key: request.key, argsHash: "different-hash" })), /reused for a different action or arguments/);
});

test("read-only reconciliation returns a verified prior result without repeating a write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bmo-tool-observed-"));
  try {
    const journal = new JsonToolCallJournal(join(directory, "calls.json"));
    const previous = call();
    await journal.put({
      key: previous.key, actionId: previous.actionId, argsHash: previous.argsHash,
      status: "dispatched", updatedAt: new Date().toISOString(),
    });
    let writes = 0;
    const outcome = await new ToolDispatcher(journal).execute(call({
      run: async () => { writes += 1; return "duplicate"; },
      reconcile: async () => ({ completed: true, result: "already-posted" }),
    }));
    assert.equal(outcome, "already-posted");
    assert.equal(writes, 0);
    assert.equal((await journal.get(previous.key))?.status, "completed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("queued cancellation is recorded before dispatch and never invokes the side effect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bmo-tool-abort-"));
  try {
    const journal = new JsonToolCallJournal(join(directory, "calls.json"));
    const dispatcher = new ToolDispatcher(journal);
    const controller = new AbortController();
    controller.abort();
    const statuses: ToolCallStatus[] = [];
    let calls = 0;
    await assert.rejects(dispatcher.execute(call({
      signal: controller.signal,
      run: async () => { calls += 1; return "unsafe"; },
      onStatus: (record: ToolCallRecord) => statuses.push(record.status),
    })), /aborted before dispatch/);
    assert.equal(calls, 0);
    assert.deepEqual(statuses, ["queued", "aborted-before-dispatch"]);
    assert.equal((await journal.get("task-1:github.comment_issue:call-1"))?.status, "aborted-before-dispatch");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancellation during dispatch journaling does not invoke the side effect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bmo-tool-race-"));
  try {
    const persisted = new JsonToolCallJournal(join(directory, "calls.json"));
    const controller = new AbortController();
    const journal = {
      get: (key: string) => persisted.get(key),
      put: async (entry: ToolCallRecord) => {
        await persisted.put(entry);
        if (entry.status === "dispatched") controller.abort();
      },
    };
    let calls = 0;
    await assert.rejects(new ToolDispatcher(journal).execute(call({
      signal: controller.signal,
      run: async () => { calls += 1; return "unsafe"; },
    })), /aborted before dispatch/);
    assert.equal(calls, 0);
    assert.equal((await persisted.get("task-1:github.comment_issue:call-1"))?.status, "aborted-before-dispatch");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancellation and timeout abort dispatched work and are journaled as distinct outcomes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bmo-tool-interrupt-"));
  try {
    const journal = new JsonToolCallJournal(join(directory, "calls.json"));
    const dispatcher = new ToolDispatcher(journal);
    const waitForAbort = (signal: AbortSignal) => new Promise<string>((_resolve) => {
      signal.addEventListener("abort", () => {}, { once: true });
    });

    const cancelledController = new AbortController();
    let markStarted!: () => void;
    const workerStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const cancelled = dispatcher.execute(call({
      key: "cancelled",
      signal: cancelledController.signal,
      run: async (signal) => { markStarted(); return waitForAbort(signal); },
    }));
    await workerStarted;
    cancelledController.abort();
    await assert.rejects(cancelled, /abort|cancel/i);
    assert.equal((await journal.get("cancelled"))?.status, "cancelled");

    const timedOut = dispatcher.execute(call({ key: "timed-out", timeoutMs: 5, run: waitForAbort }));
    await assert.rejects(timedOut, /timed out/);
    assert.equal((await journal.get("timed-out"))?.status, "timed-out");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("timeout reconciliation observes state and never blindly repeats a dispatched side effect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bmo-tool-reconcile-"));
  try {
    const journal = new JsonToolCallJournal(join(directory, "calls.json"));
    const dispatcher = new ToolDispatcher(journal);
    let invocations = 0;
    const execute = (reconcile?: () => Promise<{ completed: boolean; result?: string }>) => dispatcher.execute(call({
      key: "ambiguous-write",
      timeoutMs: 5,
      run: async (signal) => {
        invocations += 1;
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return "possibly-posted";
      },
      reconcile,
    }));
    await assert.rejects(execute(), /timed out/);
    await assert.rejects(execute(), ReconciliationRequiredError);
    assert.equal(invocations, 1);
    assert.equal((await journal.get("ambiguous-write"))?.status, "reconcile-required");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a process restart reconciles a dispatched journal entry instead of replaying it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bmo-tool-crash-"));
  try {
    const path = join(directory, "calls.json");
    const prior: ToolCallRecord = {
      key: "crashed-after-dispatch",
      actionId: "github.comment_issue",
      argsHash: toolArgumentsHash({ body: "safe" }),
      status: "dispatched",
      updatedAt: new Date().toISOString(),
    };
    await (new JsonToolCallJournal(path)).put(prior);
    const dispatcher = new ToolDispatcher(new JsonToolCallJournal(path));
    let invocations = 0;
    let reconciliations = 0;
    await assert.rejects(dispatcher.execute(call({
      key: prior.key,
      run: async () => { invocations += 1; return "duplicate"; },
      reconcile: async () => { reconciliations += 1; return { completed: false }; },
    })), ReconciliationRequiredError);
    assert.equal(invocations, 0);
    assert.equal(reconciliations, 1);
    const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, ToolCallRecord>;
    assert.equal(persisted[prior.key]?.status, "reconcile-required");
    assert.doesNotMatch(JSON.stringify(persisted), /safe|duplicate/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
