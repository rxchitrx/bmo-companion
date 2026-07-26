import assert from "node:assert/strict";
import test from "node:test";
import {
  TaskRuntime,
  type ActivityLedger,
  type TaskExecutor,
} from "../electron/task-runtime.ts";

class MemoryLedger implements ActivityLedger {
  events: Record<string, unknown>[] = [];
  async append(event: Record<string, unknown>) { this.events.push(event); }
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
