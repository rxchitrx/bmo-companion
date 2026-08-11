import assert from "node:assert/strict";
import test from "node:test";
import {
  ExecutionGuardrailTracker,
  resolveExecutionBudgets,
} from "../electron/execution-guardrails.ts";
import {
  MinimalExecutionKernel,
  type KernelLifecycleEvent,
} from "../electron/execution-kernel.ts";
import {
  allowTaskAuthority,
  createTaskAuthorityScope,
} from "../electron/permission-lifecycle.ts";
import type { TaskExecutionOptions, TaskExecutor } from "../electron/task-runtime.ts";

const AUTHORITY_NOW = new Date("2026-01-01T09:00:00.000Z");

function approvedExecution(goal: string, taskId: string): TaskExecutionOptions {
  const scope = createTaskAuthorityScope({ taskId, goal, taskKind: "general" });
  return {
    kind: "general",
    taskId,
    authority: allowTaskAuthority(
      scope,
      AUTHORITY_NOW,
      new Date("2026-01-01T11:00:00.000Z"),
    ),
  };
}

test("invalid budget overrides fall back to bounded production defaults", () => {
  const budgets = resolveExecutionBudgets({
    maxTotalTokens: Number.POSITIVE_INFINITY,
    maxDurationMs: 0,
    maxToolCalls: -1,
    maxTurns: Number.NaN,
  });

  assert.ok(Object.values(budgets).every((value) => Number.isInteger(value) && value > 0));
});

test("token exhaustion stops the worker with a deterministic summarize outcome", async () => {
  let workerAborted = false;
  const worker: TaskExecutor = {
    async execute(_goal, signal, _progress, usage) {
      usage?.({
        inputTokens: 90,
        cachedInputTokens: 20,
        outputTokens: 10,
        reasoningOutputTokens: 1,
        totalTokens: 101,
      });
      workerAborted = signal.aborted;
      return { summary: "private late result", verified: true };
    },
  };
  const result = await new MinimalExecutionKernel(worker, {
    budgets: { maxTotalTokens: 100 },
  }).execute(
    "private goal",
    new AbortController().signal,
    () => {},
    undefined,
    undefined,
    approvedExecution("private goal", "guardrail-token"),
  );

  assert.equal(workerAborted, true);
  assert.equal(result.verified, false);
  assert.equal(result.guardrailOutcome?.action, "summarize");
  assert.equal(result.guardrailOutcome?.reason, "tokens");
  assert.equal(result.guardrailOutcome?.observed, 101);
  assert.doesNotMatch(result.summary, /private/);
});

test("time exhaustion aborts a worker and returns stop instead of retrying", async () => {
  let calls = 0;
  const worker: TaskExecutor = {
    execute(_goal, signal) {
      calls += 1;
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          resolve({ summary: "late", verified: true });
        }, { once: true });
      });
    },
  };
  const result = await new MinimalExecutionKernel(worker, {
    budgets: { maxDurationMs: 5 },
  }).execute(
    "wait",
    new AbortController().signal,
    () => {},
    undefined,
    undefined,
    approvedExecution("wait", "guardrail-time"),
  );

  assert.equal(calls, 1);
  assert.equal(result.guardrailOutcome?.action, "stop");
  assert.equal(result.guardrailOutcome?.reason, "time");
});

test("turn and tool-call ceilings produce needs-decision outcomes", async () => {
  const turnWorker: TaskExecutor = {
    async execute(_goal, signal, _progress, _usage, _account, execution) {
      execution?.budgetObserver?.({ type: "turn-started" });
      execution?.budgetObserver?.({ type: "turn-started" });
      assert.equal(signal.aborted, true);
      return { summary: "late", verified: true };
    },
  };
  const turnResult = await new MinimalExecutionKernel(turnWorker, {
    budgets: { maxTurns: 1 },
  }).execute(
    "turns",
    new AbortController().signal,
    () => {},
    undefined,
    undefined,
    approvedExecution("turns", "guardrail-turns"),
  );
  assert.equal(turnResult.guardrailOutcome?.reason, "turns");
  assert.equal(turnResult.guardrailOutcome?.action, "needs-decision");

  const toolWorker: TaskExecutor = {
    async execute(_goal, signal, _progress, _usage, _account, execution) {
      execution?.budgetObserver?.({ type: "tool-started", fingerprint: "a" });
      execution?.budgetObserver?.({ type: "tool-started", fingerprint: "b" });
      assert.equal(signal.aborted, true);
      return { summary: "late", verified: true };
    },
  };
  const toolResult = await new MinimalExecutionKernel(toolWorker, {
    budgets: { maxToolCalls: 1, maxRepeatedActionOccurrences: 10 },
  }).execute(
    "tools",
    new AbortController().signal,
    () => {},
    undefined,
    undefined,
    approvedExecution("tools", "guardrail-tools"),
  );
  assert.equal(toolResult.guardrailOutcome?.reason, "tool-calls");
  assert.equal(toolResult.guardrailOutcome?.action, "needs-decision");
});

test("structural repetition detects loops without retaining action content", () => {
  const tracker = new ExecutionGuardrailTracker({
    maxRepeatedActionOccurrences: 3,
  });
  assert.equal(tracker.observe({ type: "tool-started", fingerprint: "mcp:github:get" }), undefined);
  assert.equal(tracker.observe({ type: "tool-started", fingerprint: "mcp:github:get" }), undefined);
  const outcome = tracker.observe({ type: "tool-started", fingerprint: "mcp:github:get" });

  assert.equal(outcome?.reason, "loop");
  assert.equal(outcome?.observed, 3);
  assert.doesNotMatch(JSON.stringify(outcome), /github/);
});

test("successful tools reset repeated-failure detection", () => {
  const tracker = new ExecutionGuardrailTracker({ maxRepeatedFailures: 2 });
  tracker.observe({ type: "tool-completed", fingerprint: "shape", failed: true });
  tracker.observe({ type: "tool-completed", fingerprint: "shape", failed: false });
  assert.equal(
    tracker.observe({ type: "tool-completed", fingerprint: "shape", failed: true }),
    undefined,
  );
  const outcome = tracker.observe({
    type: "tool-completed",
    fingerprint: "shape",
    failed: true,
  });
  assert.equal(outcome?.reason, "repeated-failures");
});

test("guardrail events expose counters but never raw goals or fingerprints", async () => {
  const events: KernelLifecycleEvent[] = [];
  const secret = "private-tool-shape-49281";
  const worker: TaskExecutor = {
    async execute(_goal, _signal, _progress, _usage, _account, execution) {
      execution?.budgetObserver?.({ type: "tool-started", fingerprint: secret });
      execution?.budgetObserver?.({ type: "tool-started", fingerprint: secret });
      return { summary: "late private summary", verified: true };
    },
  };
  const result = await new MinimalExecutionKernel(worker, {
    budgets: { maxRepeatedActionOccurrences: 2 },
    onEvent: (event) => events.push(event),
  }).execute(
    "private goal 72119",
    new AbortController().signal,
    () => {},
    undefined,
    undefined,
    approvedExecution("private goal 72119", "guardrail-events"),
  );

  const triggered = events.find((event) => event.type === "kernel.guardrail_triggered");
  assert.ok(triggered);
  assert.equal(result.verified, false);
  assert.doesNotMatch(JSON.stringify(triggered), /private-tool|private goal|private summary/);
});
