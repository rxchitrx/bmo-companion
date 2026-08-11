import assert from "node:assert/strict";
import test from "node:test";
import { CAPABILITY_SELECTION_LIMITS, type CapabilityManifest } from "../electron/capability-selection.ts";
import {
  MinimalExecutionKernel,
  executionResultToOutcome,
  type KernelLifecycleEvent,
} from "../electron/execution-kernel.ts";
import type { OutcomeVerifier, VerificationRequest } from "../electron/outcome-verifier.ts";
import {
  allowTaskAuthority,
  createTaskAuthorityScope,
} from "../electron/permission-lifecycle.ts";
import {
  TaskRuntime,
  type ActivityLedger,
  type TaskExecutionOptions,
  type TaskExecutor,
} from "../electron/task-runtime.ts";

const AUTHORITY_NOW = new Date("2026-01-01T09:00:00.000Z");

function approvedExecution(
  goal: string,
  options: Pick<TaskExecutionOptions, "kind" | "connectorCall" | "model" | "effort"> = {},
): TaskExecutionOptions {
  const taskId = `task-${options.kind ?? "general"}`;
  const scope = createTaskAuthorityScope({
    taskId,
    goal,
    taskKind: options.kind,
    connectorCall: options.connectorCall,
  });
  return {
    ...options,
    taskId,
    authority: allowTaskAuthority(
      scope,
      AUTHORITY_NOW,
      new Date("2026-01-01T11:00:00.000Z"),
    ),
  };
}

function connectorManifest(id = "github.comment_issue"): CapabilityManifest {
  return {
    version: 1,
    authority: "selection-only",
    limits: CAPABILITY_SELECTION_LIMITS,
    request: { charsConsidered: 20, tokenCount: 3, truncated: false },
    capabilities: [{
      id: "github",
      label: "GitHub",
      category: "work",
      actions: [{
        name: "comment_issue",
        label: "Comment on issue",
        description: "Post an approved issue comment.",
        mode: "write",
        parameters: [],
      }],
    }],
    selectedCapabilityIds: [id],
    omitted: { notAllowlisted: 0, irrelevant: 0, overLimit: 0 },
  };
}

test("the production kernel runs one scoped worker through the complete typed flow", async () => {
  const events: KernelLifecycleEvent[] = [];
  const progress: string[] = [];
  let workerCalls = 0;
  let receivedExecution: TaskExecutionOptions | undefined;
  const worker: TaskExecutor = {
    async execute(goal, _signal, report, _usage, _accountUsage, execution) {
      workerCalls += 1;
      receivedExecution = execution;
      assert.equal(goal, "Fix the focused repository test");
      report("private worker milestone");
      return { summary: "VERIFIED OUTCOME: focused test passes", verified: true };
    },
  };
  const kernel = new MinimalExecutionKernel(worker, {
    onEvent: (event) => events.push(event),
    now: () => AUTHORITY_NOW,
  });

  const result = await kernel.execute(
    "Fix the focused repository test",
    new AbortController().signal,
    (message) => progress.push(message),
    undefined,
    undefined,
    approvedExecution("Fix the focused repository test", {
      kind: "coding",
      model: "fixture",
      effort: "low",
    }),
  );

  assert.equal(workerCalls, 1);
  assert.equal(result.verified, true);
  assert.equal(result.verificationDecision?.status, "verified");
  assert.deepEqual(
    result.verificationEvidence?.map((evidence) => evidence.id),
    ["codex-task.verification-contract"],
  );
  assert.equal(receivedExecution?.contextPacket?.purpose.taskKind, "coding");
  assert.deepEqual(receivedExecution?.capabilityManifest?.selectedCapabilityIds, [
    "codex.workspace",
  ]);
  assert.equal(receivedExecution?.capabilityManifest?.worker.maxInstances, 1);
  assert.deepEqual(progress, ["private worker milestone"]);
  assert.deepEqual(events.map((event) => event.type), [
    "kernel.started",
    "kernel.context_prepared",
    "kernel.capabilities_selected",
    "kernel.permission_decided",
    "kernel.worker_started",
    "kernel.worker_progress",
    "kernel.worker_completed",
    "kernel.outcome_verified",
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.doesNotMatch(
    JSON.stringify(events.find((event) => event.type === "kernel.worker_progress")),
    /private worker milestone/,
  );
});

test("connector Tasks bind Task 4 selection to only the exact scoped worker call", async () => {
  let workerCalls = 0;
  let selectedRequest: { task: string; requestedCapabilityIds: readonly string[] } | undefined;
  const worker: TaskExecutor = {
    async execute(_goal, _signal, _progress, _usage, _accountUsage, execution) {
      workerCalls += 1;
      assert.equal(execution?.contextPacket?.purpose.taskKind, "connector");
      assert.deepEqual(execution?.contextPacket?.capabilityReferences, []);
      assert.deepEqual(execution?.capabilityManifest?.selectedCapabilityIds, [
        "github.comment_issue",
      ]);
      assert.equal(execution?.capabilityManifest?.worker.id, "connector-task");
      return { summary: "Comment posted and confirmed.", verified: true };
    },
  };
  const kernel = new MinimalExecutionKernel(worker, {
    selectConnectorCapabilities(request) {
      selectedRequest = request;
      const selected = connectorManifest();
      selected.selectedCapabilityIds.push("github.view_issue");
      return selected;
    },
    now: () => AUTHORITY_NOW,
  });

  const connectorCall = {
    service: "github",
    action: "comment_issue",
    arguments: { repo: "owner/repo", issue: 1, body: "approved" },
    mode: "write" as const,
    label: "GitHub",
  };

  const result = await kernel.execute(
    "Post the approved GitHub issue comment",
    new AbortController().signal,
    () => {},
    undefined,
    undefined,
    approvedExecution("Post the approved GitHub issue comment", {
      kind: "connector",
      connectorCall,
    }),
  );

  assert.equal(workerCalls, 1);
  assert.equal(result.verified, true);
  assert.deepEqual(selectedRequest?.requestedCapabilityIds, ["github.comment_issue"]);
});

test("TaskRuntime remains the authority and only completes a kernel-verified outcome", async () => {
  let workerCalls = 0;
  const ledger: Record<string, unknown>[] = [];
  const runtime = new TaskRuntime(
    new MinimalExecutionKernel({
      async execute() {
        workerCalls += 1;
        return { summary: "VERIFIED OUTCOME: done", verified: true };
      },
    }),
    { append: async (event) => { ledger.push(event); } } satisfies ActivityLedger,
    () => {},
  );

  const task = await runtime.create("Complete one scoped task", { kind: "general" });
  assert.equal(workerCalls, 0);
  assert.equal(task.status, "waiting_approval");
  await runtime.approve(task.id);

  assert.equal(workerCalls, 1);
  assert.equal(runtime.currentTask()?.status, "completed");
  assert.ok(ledger.some((event) => event.type === "task.approved"));
  assert.ok(ledger.some((event) => event.type === "task.completed"));
});

test("a missing selected connector capability fails closed before worker execution", async () => {
  let workerCalls = 0;
  const worker: TaskExecutor = {
    async execute() {
      workerCalls += 1;
      return { summary: "should not run", verified: true };
    },
  };
  const kernel = new MinimalExecutionKernel(worker, {
    selectConnectorCapabilities: () => connectorManifest("github.view_issue"),
    now: () => AUTHORITY_NOW,
  });

  await assert.rejects(
    kernel.execute(
      "Post a comment",
      new AbortController().signal,
      () => {},
      undefined,
      undefined,
      approvedExecution("Post a comment", {
        kind: "connector",
        connectorCall: {
          service: "github",
          action: "comment_issue",
          arguments: {},
          mode: "write",
          label: "GitHub",
        },
      }),
    ),
    /omitted github\.comment_issue/,
  );
  assert.equal(workerCalls, 0);
});

test("the VerifiedOutcome boundary downgrades contradictory or empty results", () => {
  const contradictory = executionResultToOutcome({
      summary: "VERIFIED OUTCOME: claimed",
      verified: true,
      reconciliationRequired: true,
    });
  assert.equal(contradictory.status, "unverified");
  assert.equal(contradictory.status === "unverified" && contradictory.reason,
    "reconciliation-required");
  assert.deepEqual(contradictory.verification.reasons.map((reason) => reason.code), [
    "reconciliation-required",
    "contradictory-evidence",
  ]);
  assert.equal(
    executionResultToOutcome({ summary: "", verified: true }).status,
    "unverified",
  );
});

test("explicit missing or contradictory worker evidence cannot inherit legacy verification", async () => {
  const missing = await new MinimalExecutionKernel({
    async execute() {
      return {
        summary: "Claimed complete.",
        verified: true,
        verificationEvidence: [],
      };
    },
  }, { now: () => AUTHORITY_NOW }).execute(
    "Check the outcome",
    new AbortController().signal,
    () => {},
    undefined,
    undefined,
    approvedExecution("Check the outcome"),
  );
  assert.equal(missing.verified, false);
  assert.deepEqual(missing.verificationDecision?.reasons.map((reason) => reason.code), [
    "missing-evidence",
  ]);

  const contradictory = await new MinimalExecutionKernel({
    async execute() {
      return {
        summary: "Claimed complete.",
        verified: true,
        verificationEvidence: [{
          id: "state.not-satisfied",
          kind: "state-observation",
          source: "fixture",
          polarity: "contradicts",
          strength: "direct",
          statement: "The requested condition was not present.",
        }],
      };
    },
  }, { now: () => AUTHORITY_NOW }).execute(
    "Check the outcome",
    new AbortController().signal,
    () => {},
    undefined,
    undefined,
    approvedExecution("Check the outcome"),
  );
  assert.equal(contradictory.verified, false);
  assert.ok(contradictory.verificationDecision?.reasons.some((reason) =>
    reason.code === "contradictory-evidence"));
});

test("the kernel's typed verifier decision is authoritative over the worker claim", async () => {
  let received: VerificationRequest | undefined;
  const verifier: OutcomeVerifier = {
    verify(request) {
      received = request;
      return {
        version: 1,
        status: "unverified",
        reasons: [{ code: "insufficient-direct-evidence", evidenceIds: [] }],
        evidence: {
          considered: request.evidence.length,
          supporting: 0,
          contradictory: 0,
          directSupporting: 0,
        },
      };
    },
  };
  const result = await new MinimalExecutionKernel({
    async execute() {
      return { summary: "Worker claimed completion.", verified: true };
    },
  }, { verifier, now: () => AUTHORITY_NOW }).execute(
    "Verify one outcome",
    new AbortController().signal,
    () => {},
    undefined,
    undefined,
    approvedExecution("Verify one outcome"),
  );
  assert.equal(received?.workerClaimedVerified, true);
  assert.equal(received?.evidence.length, 1);
  assert.equal(result.verified, false);
  assert.equal(result.verificationDecision?.status, "unverified");
});

test("kernel diagnostics contain context metadata but not raw Task values", async () => {
  const privateGoal = "private task goal 92741";
  const privateSummary = "VERIFIED OUTCOME: private result 38152";
  const logs: string[] = [];
  const priorLog = console.log;
  console.log = (...values: unknown[]) => logs.push(values.join(" "));
  try {
    await new MinimalExecutionKernel({
      async execute(_goal, _signal, report) {
        report("private progress 61409");
        return { summary: privateSummary, verified: true };
      },
    }, { now: () => AUTHORITY_NOW }).execute(
      privateGoal,
      new AbortController().signal,
      () => {},
      undefined,
      undefined,
      approvedExecution(privateGoal),
    );
  } finally {
    console.log = priorLog;
  }
  const serialized = logs.join("\n");
  assert.doesNotMatch(serialized, /private task goal 92741/);
  assert.doesNotMatch(serialized, /private result 38152/);
  assert.doesNotMatch(serialized, /private progress 61409/);
  assert.match(serialized, /kernel\.outcome_verified/);
  assert.match(serialized, /contextUsedChars/);
});

test("worker failures are emitted once and are never retried by the kernel", async () => {
  let calls = 0;
  const events: KernelLifecycleEvent[] = [];
  const kernel = new MinimalExecutionKernel({
    async execute() {
      calls += 1;
      throw new TypeError("private worker failure");
    },
  }, {
    onEvent: (event) => events.push(event),
    now: () => AUTHORITY_NOW,
  });

  await assert.rejects(
    kernel.execute(
      "Run one worker",
      new AbortController().signal,
      () => {},
      undefined,
      undefined,
      approvedExecution("Run one worker"),
    ),
    /private worker failure/,
  );
  assert.equal(calls, 1);
  assert.equal(events.at(-1)?.type, "kernel.failed");
  assert.equal(
    events.filter((event) => event.type === "kernel.worker_started").length,
    1,
  );
});
