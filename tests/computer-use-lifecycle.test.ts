import assert from "node:assert/strict";
import test from "node:test";
import { CodexTaskLifecycle } from "../electron/codex-task-lifecycle.ts";
import {
  ComputerUseHealth,
  type ComputerUseProcessController,
} from "../electron/computer-use-health.ts";

test("a turn cannot settle while an owned protocol item is still active", async () => {
  const lifecycle = new CodexTaskLifecycle();
  lifecycle.itemStarted({ id: "tool-1", type: "mcpToolCall" });
  lifecycle.turnCompleted();

  const unsettled = await lifecycle.waitForSettlement(new AbortController().signal, {
    timeoutMs: 20,
    quietMs: 0,
  });
  assert.equal(unsettled.settled, false);
  assert.deepEqual(unsettled.activeItems, [
    { id: "tool-1", type: "mcpToolCall" },
  ]);

  lifecycle.itemCompleted({ id: "tool-1", type: "mcpToolCall" });
  const settled = await lifecycle.waitForSettlement(new AbortController().signal, {
    timeoutMs: 20,
    quietMs: 0,
  });
  assert.equal(settled.settled, true);
});

test("revocation clears ownership and ignores late item starts", () => {
  const lifecycle = new CodexTaskLifecycle();
  lifecycle.itemStarted({ id: "tool-1", type: "mcpToolCall" });
  lifecycle.revoke();
  lifecycle.itemStarted({ id: "late-tool", type: "mcpToolCall" });

  assert.deepEqual(lifecycle.snapshot().activeItems, []);
  assert.equal(lifecycle.snapshot().settled, false);
});

class FakeProcesses implements ComputerUseProcessController {
  helpers = [10];
  running = new Set([10]);
  terminated: number[] = [];

  async listExactHelpers() {
    return [...this.helpers];
  }

  terminate(pid: number) {
    this.terminated.push(pid);
    this.running.delete(pid);
  }

  async isRunning(pid: number) {
    return this.running.has(pid);
  }
}

test("quarantine terminates only a Computer Use helper created during the Task", async () => {
  const processes = new FakeProcesses();
  const health = new ComputerUseHealth(processes);
  const lease = await health.beginTask("computer");
  processes.helpers = [10, 20];
  processes.running.add(20);

  const result = await health.quarantineOwnedSession(
    lease,
    "The Computer Use session was stopped.",
    () => {},
  );

  assert.deepEqual(result.stoppedPids, [20]);
  assert.deepEqual(result.skippedSharedPids, [10]);
  assert.deepEqual(processes.terminated, [20]);
});

test("a stale shared helper is never terminated while preparing a fresh Task session", async () => {
  const processes = new FakeProcesses();
  const health = new ComputerUseHealth(processes);
  const progress: string[] = [];
  health.observeFailure("The Computer Use session was stopped.");

  await health.prepare("computer", (message) => progress.push(message));

  assert.equal(progress.length, 1);
  assert.deepEqual(processes.terminated, []);
});
