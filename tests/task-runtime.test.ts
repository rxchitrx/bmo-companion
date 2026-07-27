import assert from "node:assert/strict";
import test from "node:test";
import {
  TaskRuntime,
  type ActivityLedger,
  type DirectiveTracker,
  type RecoveryObserver,
  type StoredTask,
  type TaskStore,
  type TaskExecutor,
} from "../electron/task-runtime.ts";

class MemoryLedger implements ActivityLedger {
  events: Record<string, unknown>[] = [];
  async append(event: Record<string, unknown>) { this.events.push(event); }
}

class MemoryStore implements TaskStore {
  value: StoredTask | null = null;
  async load() { return this.value ? structuredClone(this.value) : null; }
  async save(task: StoredTask | null) { this.value = task ? structuredClone(task) : null; }
}

function clock(start = "2026-01-01T09:00:00.000Z") {
  let value = new Date(start);
  return { now: () => new Date(value), advance: (minutes: number) => { value = new Date(value.getTime() + minutes * 60_000); } };
}

test("one approval drives a general Task to Verified Outcome", async () => {
  const ledger = new MemoryLedger();
  const updates: string[] = [];
  const executor: TaskExecutor = {
    async execute(goal, _signal, progress) {
      assert.equal(goal, "Open the requested page and verify it");
      progress("Observed the current browser state.");
      return { summary: "The page is visibly open.", verified: true };
    },
  };
  const runtime = new TaskRuntime(executor, ledger, (task) => updates.push(task.status));
  const task = await runtime.create("Open the requested page and verify it");
  assert.equal(task.status, "waiting_approval");

  await runtime.approve(task.id);

  assert.deepEqual(updates, ["waiting_approval", "running", "running", "completed"]);
  assert.equal(ledger.events.at(-1)?.type, "task.completed");
  assert.equal(ledger.events.at(-1)?.verified, true);
});

test("a Task freezes its selected capability model through approval and execution", async () => {
  let receivedModel: { model: string; effort: string } | undefined;
  const runtime = new TaskRuntime(
    {
      async execute(_goal, _signal, _progress, _usage, _accountUsage, model) {
        receivedModel = model;
        return { summary: "Verified with the selected worker.", verified: true };
      },
    },
    new MemoryLedger(),
    () => {},
  );
  const task = await runtime.create("Fix the repository", {
    kind: "coding",
    model: "gpt-5.6-sol",
    effort: "high",
  });
  assert.equal(task.kind, "coding");
  assert.equal(task.model, "gpt-5.6-sol");
  await runtime.approve(task.id);
  assert.deepEqual(receivedModel, {
    model: "gpt-5.6-sol",
    effort: "high",
    kind: "coding",
  });
});

test("task usage is published live and persisted with the verified outcome", async () => {
  const ledger = new MemoryLedger();
  const updates: StoredTask["task"][] = [];
  const executor: TaskExecutor = {
    async execute(_goal, _signal, _progress, usage) {
      usage?.({
        inputTokens: 900,
        cachedInputTokens: 600,
        outputTokens: 100,
        reasoningOutputTokens: 30,
        totalTokens: 1000,
      });
      return {
        summary: "Verified.",
        verified: true,
        usage: {
          inputTokens: 900,
          cachedInputTokens: 600,
          outputTokens: 100,
          reasoningOutputTokens: 30,
          totalTokens: 1000,
        },
      };
    },
  };
  const runtime = new TaskRuntime(
    executor,
    ledger,
    (task) => updates.push(task),
  );
  const task = await runtime.create("Track this task");
  await runtime.approve(task.id);

  assert.equal(updates.some((update) => update.usage?.totalTokens === 1000), true);
  assert.deepEqual(ledger.events.at(-1)?.usage, {
    inputTokens: 900,
    cachedInputTokens: 600,
    outputTokens: 100,
    reasoningOutputTokens: 30,
    totalTokens: 1000,
  });
});

test("an unverified attempt never becomes completed", async () => {
  const ledger = new MemoryLedger();
  let lastStatus = "";
  const executor: TaskExecutor = {
    async execute() {
      return { summary: "I could not confirm the visible result.", verified: false };
    },
  };
  const runtime = new TaskRuntime(executor, ledger, (task) => { lastStatus = task.status; });
  const task = await runtime.create("Do a generic external task");
  await runtime.approve(task.id);

  assert.equal(lastStatus, "failed");
  assert.equal(ledger.events.at(-1)?.type, "task.failed");
});

test("a stopped Computer Use session is reported as unverified without automatic retry", async () => {
  const ledger = new MemoryLedger();
  const store = new MemoryStore();
  let executions = 0;
  const runtime = new TaskRuntime(
    {
      async execute() {
        executions += 1;
        return {
          summary: "The Computer Use session was stopped before Safari could be verified.",
          verified: false,
        };
      },
    },
    ledger,
    () => {},
    undefined,
    store,
  );
  const task = await runtime.create("Open Safari", {
    kind: "computer",
    model: "gpt-5.6-luna",
    effort: "high",
  });

  await runtime.approve(task.id);

  assert.equal(executions, 1);
  assert.equal(store.value?.task.status, "failed");
  assert.match(store.value?.task.summary ?? "", /Mac may already have changed/);
  assert.match(store.value?.task.summary ?? "", /will not retry automatically/);
});

test("denial leaves the Mac unchanged and records cancellation", async () => {
  const ledger = new MemoryLedger();
  let executed = false;
  const executor: TaskExecutor = {
    async execute() { executed = true; return { summary: "", verified: true }; },
  };
  const runtime = new TaskRuntime(executor, ledger, () => {});
  const task = await runtime.create("Do not run this");
  await runtime.deny(task.id);

  assert.equal(executed, false);
  assert.equal(ledger.events.at(-1)?.type, "task.cancelled");
});

test("owner Stop revokes authority before a worker can publish late progress or completion", async () => {
  const ledger = new MemoryLedger();
  const updates: Array<{ status: string; progress: string[] }> = [];
  let workerStarted!: () => void;
  const started = new Promise<void>((resolve) => { workerStarted = resolve; });
  const executor: TaskExecutor = {
    execute: async (_goal, signal, progress) =>
      new Promise((resolve) => {
        workerStarted();
        signal.addEventListener("abort", () => {
          progress("Late progress after authority revocation.");
          resolve({ summary: "Late verified result.", verified: true });
        }, { once: true });
      }),
  };
  const runtime = new TaskRuntime(
    executor,
    ledger,
    (task) => updates.push({ status: task.status, progress: [...task.progress] }),
  );
  const task = await runtime.create("Keep operating until stopped");
  const approval = runtime.approve(task.id);
  await started;

  assert.equal(await runtime.cancelActive(), true);
  await approval;

  assert.equal(updates.at(-1)?.status, "cancelled");
  assert.equal(
    updates.some((update) =>
      update.progress.includes("Late progress after authority revocation.")),
    false,
  );
  assert.equal(
    ledger.events.some((event) => event.type === "task.completed"),
    false,
  );
  assert.equal(ledger.events.at(-1)?.reason, "owner_stop");
  assert.equal(await runtime.cancelActive(), false);
});

test("pending approvals remind at 2, 5, and 10 minutes, then use the attention cadence", async () => {
  const time = clock();
  const ledger = new MemoryLedger();
  const runtime = new TaskRuntime({ async execute() { throw new Error("not called"); } }, ledger, () => {}, time.now, new MemoryStore());
  await runtime.create("Wait for approval");

  time.advance(2); await runtime.sendDueReminders();
  time.advance(3); await runtime.sendDueReminders();
  time.advance(5); await runtime.sendDueReminders();
  time.advance(30); await runtime.sendDueReminders();

  assert.deepEqual(
    ledger.events.filter((event) => event.type === "task.reminder").map((event) => event.cadenceMinutes),
    [2, 5, 10, 30],
  );
  assert.equal(ledger.events.filter((event) => event.type === "task.reminder").at(-1)?.attentionPolicyAware, true);
});

test("an approval expires after two hours and requires direct extension", async () => {
  const time = clock();
  const ledger = new MemoryLedger();
  const store = new MemoryStore();
  let release!: () => void;
  const executor: TaskExecutor = { execute: async () => new Promise((resolve) => { release = () => resolve({ summary: "done", verified: true }); }) };
  const observer: RecoveryObserver = { async observe() { return { scopeStillMatches: true }; } };
  const runtime = new TaskRuntime(executor, ledger, () => {}, time.now, store, observer);
  const task = await runtime.create("A bounded Task");
  const approve = runtime.approve(task.id);
  await new Promise((resolve) => setImmediate(resolve));
  time.advance(120);
  await runtime.setExecutionSurfaceAvailable(true);
  await runtime.sendDueReminders();
  assert.equal(store.value?.task.status, "needs_decision");
  assert.equal(ledger.events.at(-1)?.type, "task.approval_expired");
  await runtime.extendApproval(task.id);
  assert.ok(store.value?.task.approvalExpiresAt);
  release(); await approve;
});

test("restart restores context without action replay and requires observation before resume", async () => {
  const time = clock();
  const ledger = new MemoryLedger();
  const store = new MemoryStore();
  let executes = 0;
  const executor: TaskExecutor = { async execute() { executes += 1; return { summary: "verified", verified: true }; } };
  const first = new TaskRuntime(executor, ledger, () => {}, time.now, store);
  const task = await first.create("Change a visible setting");
  // Simulate a process ending after authority was recorded but before work starts.
  store.value!.task.status = "running";
  store.value!.task.approvalExpiresAt = new Date(time.now().getTime() + 60_000).toISOString();
  const updates: string[] = [];
  const observer: RecoveryObserver = { async observe() { return { scopeStillMatches: true, detail: "Observed current setting." }; } };
  const restored = new TaskRuntime(executor, ledger, (snapshot) => updates.push(snapshot.status), time.now, store, observer);
  await restored.restore();
  assert.equal(executes, 0);
  assert.equal(store.value?.task.status, "suspended");
  await restored.recover(task.id);
  assert.equal(executes, 1);
  assert.ok(ledger.events.some((event) => event.type === "task.recovery_observed"));
  assert.ok(ledger.events.some((event) => event.type === "task.recovery_revalidated" && event.actionReplay === false));
  assert.deepEqual(updates, ["suspended", "running", "completed"]);
});

test("a locked Mac suspends work and only resumes through valid recovery authority", async () => {
  const time = clock();
  const ledger = new MemoryLedger();
  const store = new MemoryStore();
  let executes = 0;
  const executor: TaskExecutor = { async execute() { executes += 1; return { summary: "done", verified: true }; } };
  const first = new TaskRuntime(executor, ledger, () => {}, time.now, store);
  const task = await first.create("Use the Mac");
  store.value!.task.status = "running";
  store.value!.task.approvalExpiresAt = new Date(time.now().getTime() + 60_000).toISOString();
  const observer: RecoveryObserver = { async observe() { return { scopeStillMatches: true }; } };
  const runtime = new TaskRuntime(executor, ledger, () => {}, time.now, store, observer);
  await runtime.restore();
  await runtime.setExecutionSurfaceAvailable(false);
  await runtime.setExecutionSurfaceAvailable(true);
  assert.equal(executes, 0);
  await runtime.recover(task.id);
  assert.equal(executes, 1);
});

test("repeated failed Directive Tasks suspend their Standing Directive", async () => {
  const ledger = new MemoryLedger();
  const tracker: DirectiveTracker = { async recordFailure() { return { suspended: true, consecutiveFailures: 3 }; } };
  const executor: TaskExecutor = { async execute() { return { summary: "blocked", verified: false }; } };
  const runtime = new TaskRuntime(executor, ledger, () => {}, undefined, undefined, undefined, tracker);
  const task = await runtime.create("Respond to a Signal", { directiveId: "morning-briefing" });
  await runtime.approve(task.id);
  assert.ok(ledger.events.some((event) => event.type === "directive.suspended" && event.directiveId === "morning-briefing"));
});

test("a Verified Outcome creates bounded memory tied to its Task Ledger entry", async () => {
  const ledger = new MemoryLedger();
  const remembered: Array<{ taskId: string; goal: string; summary: string }> = [];
  const runtime = new TaskRuntime(
    { async execute() { return { summary: "The project page is published.", verified: true }; } },
    ledger,
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { async rememberCompletedTask(input) { remembered.push(input); } },
  );
  const task = await runtime.create("Publish the project page");
  await runtime.approve(task.id);

  assert.deepEqual(remembered, [{ taskId: task.id, goal: "Publish the project page", summary: "The project page is published.", artifacts: undefined }]);
  assert.equal(ledger.events.at(-1)?.taskId, task.id);
});

test("a memory write failure does not erase a Verified Outcome", async () => {
  const ledger = new MemoryLedger();
  let latestStatus = "";
  const runtime = new TaskRuntime(
    { async execute() { return { summary: "The task is verified.", verified: true }; } },
    ledger,
    (task) => { latestStatus = task.status; },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { async rememberCompletedTask() { throw new Error("disk unavailable"); } },
  );
  const task = await runtime.create("Complete a safe task");
  await runtime.approve(task.id);

  assert.equal(latestStatus, "completed");
  assert.equal(ledger.events.at(-1)?.type, "memory.write_failed");
});
