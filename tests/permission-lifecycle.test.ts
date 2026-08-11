import assert from "node:assert/strict";
import test from "node:test";
import { MinimalExecutionKernel, type KernelLifecycleEvent } from "../electron/execution-kernel.ts";
import {
  allowTaskAuthority,
  askForTaskAuthority,
  createTaskAuthorityScope,
  denyTaskAuthority,
  evaluateTaskAuthority,
} from "../electron/permission-lifecycle.ts";
import {
  TaskRuntime,
  type ActivityLedger,
  type StoredTask,
  type TaskExecutionOptions,
  type TaskStore,
} from "../electron/task-runtime.ts";

const NOW = new Date("2026-01-01T09:00:00.000Z");
const EXPIRES = new Date("2026-01-01T11:00:00.000Z");

class MemoryLedger implements ActivityLedger {
  events: Record<string, unknown>[] = [];
  async append(event: Record<string, unknown>) { this.events.push(event); }
}

class MemoryStore implements TaskStore {
  value: StoredTask | null = null;
  async load() { return this.value ? structuredClone(this.value) : null; }
  async save(value: StoredTask | null) {
    this.value = value ? structuredClone(value) : null;
  }
}

function approvedExecution(goal: string, taskId: string): TaskExecutionOptions {
  const scope = createTaskAuthorityScope({ taskId, goal });
  return {
    taskId,
    kind: "general",
    authority: allowTaskAuthority(scope, NOW, EXPIRES),
  };
}

test("policy decisions are explicit and fail closed for missing, expired, denied, or changed scope", () => {
  const scope = createTaskAuthorityScope({ taskId: "task-1", goal: "Open Safari" });
  const asked = askForTaskAuthority(scope, NOW);
  const allowed = allowTaskAuthority(scope, NOW, EXPIRES);
  const denied = denyTaskAuthority(allowed, NOW, "owner-denied");
  const changedScope = createTaskAuthorityScope({ taskId: "task-1", goal: "Open Terminal" });

  assert.deepEqual(evaluateTaskAuthority(undefined, scope, NOW), {
    decision: "ask",
    reason: "owner-approval-required",
  });
  assert.deepEqual(evaluateTaskAuthority(asked, scope, NOW), {
    decision: "ask",
    reason: "owner-approval-required",
  });
  assert.deepEqual(evaluateTaskAuthority(allowed, scope, NOW), {
    decision: "allow",
    reason: "authority-allowed",
  });
  assert.deepEqual(evaluateTaskAuthority(denied, scope, NOW), {
    decision: "deny",
    reason: "authority-revoked",
  });
  assert.deepEqual(evaluateTaskAuthority(allowed, changedScope, NOW), {
    decision: "deny",
    reason: "scope-mismatch",
  });
  assert.deepEqual(evaluateTaskAuthority(allowed, scope, EXPIRES), {
    decision: "ask",
    reason: "authority-expired",
  });
});

test("TaskRuntime persists ask, grants one scoped allow, then revokes authority at settlement", async () => {
  const store = new MemoryStore();
  let received: TaskExecutionOptions | undefined;
  const runtime = new TaskRuntime(
    {
      async execute(_goal, _signal, _progress, _usage, _accountUsage, execution) {
        received = execution;
        return { summary: "done", verified: true };
      },
    },
    new MemoryLedger(),
    () => {},
    () => new Date(NOW),
    store,
  );

  const task = await runtime.create("Complete the scoped task");
  assert.equal(task.authority?.decision, "ask");
  assert.equal(task.authority?.state, "pending");
  assert.equal(task.authority?.scope.taskId, task.id);

  await runtime.approve(task.id);

  assert.equal(received?.authority?.decision, "allow");
  assert.equal(received?.authority?.state, "active");
  assert.equal(received?.authority?.expiresAt, EXPIRES.toISOString());
  assert.equal(store.value?.task.status, "completed");
  assert.equal(store.value?.task.authority?.decision, "deny");
  assert.equal(store.value?.task.authority?.state, "revoked");
});

test("pause aborts the worker and resume revalidates before starting one replacement", async () => {
  const ledger = new MemoryLedger();
  const store = new MemoryStore();
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const runtime = new TaskRuntime(
    {
      async execute(_goal, signal) {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (calls === 1) {
          firstStarted();
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }));
          active -= 1;
          return { summary: "aborted", verified: false };
        }
        active -= 1;
        return { summary: "resumed", verified: true };
      },
    },
    ledger,
    () => {},
    () => new Date(NOW),
    store,
    { async observe() { return { scopeStillMatches: true, detail: "scope matches" }; } },
  );
  const task = await runtime.create("Use one Mac-control worker");
  const approval = runtime.approve(task.id);
  await started;

  await runtime.pause(task.id);
  await approval;
  assert.equal(store.value?.task.status, "suspended");
  assert.equal(store.value?.task.authority?.state, "paused");

  await runtime.resume(task.id);

  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
  assert.equal(store.value?.task.status, "completed");
  assert.ok(ledger.events.some((event) => event.type === "task.paused"));
  assert.ok(ledger.events.some((event) => event.type === "task.recovery_revalidated"));
});

test("recovery rejects a restored Task whose objective no longer matches its approved scope", async () => {
  const store = new MemoryStore();
  let observed = false;
  let executed = false;
  const first = new TaskRuntime(
    { async execute() { return { summary: "unused", verified: true }; } },
    new MemoryLedger(),
    () => {},
    () => new Date(NOW),
    store,
  );
  const task = await first.create("Open Safari");
  store.value!.approvalGrantedAt = NOW.toISOString();
  store.value!.task.approvalExpiresAt = EXPIRES.toISOString();
  store.value!.task.authority = allowTaskAuthority(
    task.authority!.scope,
    NOW,
    EXPIRES,
  );
  store.value!.task.status = "running";
  store.value!.task.goal = "Open Terminal";

  const restored = new TaskRuntime(
    { async execute() { executed = true; return { summary: "unsafe", verified: true }; } },
    new MemoryLedger(),
    () => {},
    () => new Date(NOW),
    store,
    { async observe() { observed = true; return { scopeStillMatches: true }; } },
  );
  await restored.restore();
  await restored.resume(task.id);

  assert.equal(observed, false);
  assert.equal(executed, false);
  assert.equal(store.value?.task.status, "needs_decision");
  assert.match(store.value?.task.summary ?? "", /scope-mismatch/);
});

test("restoring a settled legacy Task never reconstructs active authority", async () => {
  const store = new MemoryStore();
  store.value = {
    task: {
      id: "legacy-complete",
      goal: "Already finished",
      status: "completed",
      state: "speaking",
      progress: ["Completed."],
      approvalExpiresAt: EXPIRES.toISOString(),
    },
    approvalGrantedAt: NOW.toISOString(),
    reminderIndex: 0,
    executionSurfaceAvailable: true,
  };
  const runtime = new TaskRuntime(
    { async execute() { throw new Error("must not execute"); } },
    new MemoryLedger(),
    () => {},
    () => new Date(NOW),
    store,
  );

  const restored = await runtime.restore();

  assert.equal(restored?.status, "completed");
  assert.equal(restored?.authority?.decision, "deny");
  assert.equal(restored?.authority?.state, "revoked");
});

test("kernel rejects unapproved work and admits only one Mac-control worker", async () => {
  const events: KernelLifecycleEvent[] = [];
  let calls = 0;
  let release!: () => void;
  const workerDone = new Promise<void>((resolve) => { release = resolve; });
  const kernel = new MinimalExecutionKernel(
    {
      async execute() {
        calls += 1;
        await workerDone;
        return { summary: "done", verified: true };
      },
    },
    { onEvent: (event) => events.push(event), now: () => NOW },
  );
  const unapprovedScope = createTaskAuthorityScope({ taskId: "ask", goal: "Do not run" });
  await assert.rejects(
    kernel.execute(
      "Do not run",
      new AbortController().signal,
      () => {},
      undefined,
      undefined,
      { taskId: "ask", authority: askForTaskAuthority(unapprovedScope, NOW) },
    ),
    /Task authority ask/,
  );
  assert.equal(calls, 0);

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    kernel.execute(
      "Cancelled task",
      cancelled.signal,
      () => {},
      undefined,
      undefined,
      approvedExecution("Cancelled task", "cancelled"),
    ),
    /Task authority deny: authority-revoked/,
  );
  assert.equal(calls, 0);

  const first = kernel.execute(
    "First task",
    new AbortController().signal,
    () => {},
    undefined,
    undefined,
    approvedExecution("First task", "first"),
  );
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    kernel.execute(
      "Second task",
      new AbortController().signal,
      () => {},
      undefined,
      undefined,
      approvedExecution("Second task", "second"),
    ),
    /Mac-control worker is already active/,
  );
  assert.equal(calls, 1);
  release();
  await first;
  assert.ok(events.some((event) =>
    event.type === "kernel.permission_decided" && event.decision === "ask"));
});
