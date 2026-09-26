import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  TRAJECTORY_REPLAY_FIXTURES,
  TrajectoryRecorder,
  replayTrajectory,
  validateTrajectoryRecord,
  type TrajectoryRecord,
} from "../electron/trajectory.ts";
import { MinimalExecutionKernel, type KernelLifecycleEvent } from "../electron/execution-kernel.ts";
import { allowTaskAuthority, createTaskAuthorityScope } from "../electron/permission-lifecycle.ts";
import type { TaskExecutor } from "../electron/task-runtime.ts";

function baseRecorder(trajectoryId = "fixture-trajectory") {
  return new TrajectoryRecorder({
    taskId: "fixture-task-1",
    goal: "Complete the private fixture task.",
    kind: "coding",
    model: "fixture-model",
    effort: "low",
    trajectoryId,
  });
}

function event(
  sequence: number,
  type: string,
  metadata: Record<string, unknown> = {},
) {
  return { sequence, type, metadata };
}

function recordFor(
  fixtureId: keyof typeof TRAJECTORY_REPLAY_FIXTURES,
  events: Array<{ sequence: number; type: string; metadata?: Record<string, unknown> }>,
): TrajectoryRecord {
  const recorder = baseRecorder(fixtureId);
  for (const item of events) recorder.recordLifecycleEvent(item);
  return recorder.toRecord();
}

test("trajectory recording retains metadata and digests content", () => {
  const recorder = baseRecorder("privacy-fixture");
  recorder.recordContextMetadata({
    packetVersion: "1",
    itemCount: 2,
    usedContentChars: 42,
    segments: [{
      name: "task_goal",
      source: "TaskSnapshot.goal",
      provenance: "user",
      measurement: "exact-visible",
      chars: 42,
      utf8Bytes: 44,
      sha256: "a".repeat(64),
    }],
  });
  recorder.recordLifecycleEvent(event(1, "task.created", { goal: "private user prompt" }));
  recorder.recordLifecycleEvent(event(2, "user.correction", { detail: "do not expose this correction" }));
  recorder.recordCapabilities({
    selectedCapabilityIds: ["codex.workspace"],
    capabilities: [{
      id: "codex.workspace",
      source: "context-packet",
      reason: "The approved Task needs workspace access.",
    }],
  });
  recorder.recordUsage({
    inputTokens: 120,
    cachedInputTokens: 40,
    outputTokens: 8,
    reasoningOutputTokens: 2,
    totalTokens: 128,
  }, 3);
  recorder.recordGuardrailOutcome({
    version: 1,
    action: "needs-decision",
    reason: "tool-calls",
    observed: 3,
    limit: 3,
    summary: "Private guardrail text must not be persisted.",
  }, 4);
  recorder.recordVerification(
    {
      version: 1,
      status: "verified",
      reasons: [{ code: "direct-supporting-evidence", evidenceIds: ["fixture.evidence"] }],
      evidence: { considered: 1, supporting: 1, contradictory: 0, directSupporting: 1 },
    },
    [{
      id: "fixture.evidence",
      kind: "worker-contract",
      source: "fixture-worker",
      polarity: "supports",
      strength: "direct",
      statement: "A private verification statement.",
    }],
  );
  recorder.recordUserCorrection("scope-change", "A private owner correction.", 5);

  const record = recorder.toRecord();
  assert.deepEqual(validateTrajectoryRecord(record), []);
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /private user prompt|do not expose|Private guardrail|private owner correction|private verification/);
  assert.equal(record.privacy.rawContent, false);
  assert.equal(record.privacy.replayExecutesTools, false);
  assert.equal(record.events[0]?.metadata.goal && typeof record.events[0].metadata.goal, "object");
  assert.equal(record.guardrailOutcomes[0]?.summaryDigest.sha256.length, 64);
  assert.equal(record.verificationEvidence[0]?.statementDigest.sha256.length, 64);
});

test("a verified kernel outcome is represented in the trace with the matching decision", async () => {
  const now = new Date("2026-09-24T10:00:00.000Z");
  const taskId = "trace-verified-task";
  const goal = "Read one approved fixture value";
  const scope = createTaskAuthorityScope({ taskId, goal, taskKind: "general" });
  const events: KernelLifecycleEvent[] = [];
  const worker: TaskExecutor = {
    async execute() {
      return { summary: "The approved fixture value is visible.", verified: true };
    },
  };
  const kernel = new MinimalExecutionKernel(worker, {
    onEvent: (event) => events.push(event),
    now: () => now,
  });
  const result = await kernel.execute(
    goal,
    new AbortController().signal,
    () => {},
    undefined,
    undefined,
    {
      taskId,
      kind: "general",
      authority: allowTaskAuthority(scope, now, new Date("2026-09-24T11:00:00.000Z")),
    },
  );
  const recorder = new TrajectoryRecorder({
    taskId,
    goal,
    kind: "general",
    model: "fixture-model",
    effort: "low",
    trajectoryId: "trace-verified-outcome",
  });
  for (const event of events) recorder.recordKernelEvent(event);
  const record = recorder.toRecord();
  const outcome = record.events.find((entry) => entry.type === "kernel.outcome_verified");

  assert.equal(result.verified, true);
  assert.equal(result.verificationDecision?.status, "verified");
  assert.equal(outcome?.metadata.outcomeStatus, "verified");
  assert.equal(record.events.at(-1)?.type, "kernel.outcome_verified");
  assert.deepEqual(validateTrajectoryRecord(record), []);
});

test("usage snapshots are stored as deterministic deltas", () => {
  const recorder = baseRecorder();
  recorder.recordUsage({ inputTokens: 100, cachedInputTokens: 40, outputTokens: 10, reasoningOutputTokens: 2, totalTokens: 110 }, 1);
  recorder.recordUsage({ inputTokens: 160, cachedInputTokens: 80, outputTokens: 15, reasoningOutputTokens: 5, totalTokens: 175 }, 2);
  assert.deepEqual(recorder.toRecord().usageDeltas, [
    { sequence: 1, inputTokens: 100, cachedInputTokens: 40, outputTokens: 10, reasoningOutputTokens: 2, totalTokens: 110 },
    { sequence: 2, inputTokens: 60, cachedInputTokens: 40, outputTokens: 5, reasoningOutputTokens: 3, totalTokens: 65 },
  ]);
});

test("kernel lifecycle events are reduced to safe decision metadata", () => {
  const recorder = baseRecorder();
  recorder.recordKernelEvent({
    version: 1,
    runId: "fixture-run",
    sequence: 1,
    type: "kernel.worker_progress",
    message: { chars: 24, sha256: "b".repeat(12) },
  });
  const record = recorder.toRecord();
  assert.deepEqual(record.events[0], {
    sequence: 1,
    type: "kernel.worker_progress",
    metadata: { message: { chars: 24, utf8Bytes: 24, sha256: "b".repeat(12) } },
  });
});

test("deterministic replay applies approval, cancellation, completion, and correction paths", () => {
  const approvalPause = recordFor("approval-pause", [
    event(1, "task.created"),
    event(2, "kernel.permission_decided", { decision: "ask", reason: "owner-approval-required" }),
    event(3, "task.needs_decision"),
  ]);
  const stopCancel = recordFor("stop-cancel", [
    event(1, "task.created"),
    event(2, "task.approved"),
    event(3, "kernel.permission_decided", { decision: "allow", reason: "authority-allowed" }),
    event(4, "kernel.worker_started", { workerId: "codex-task" }),
    event(5, "task.cancelled"),
  ]);
  const completion = recordFor("verified-completion", [
    event(1, "task.created"),
    event(2, "task.approved"),
    event(3, "kernel.permission_decided", { decision: "allow", reason: "authority-allowed" }),
    event(4, "kernel.worker_started", { workerId: "codex-task" }),
    event(5, "kernel.outcome_verified", { outcomeStatus: "verified" }),
    event(6, "task.completed"),
  ]);
  const guardrail = recordFor("guardrail-decision", [
    event(1, "task.created"),
    event(2, "task.approved"),
    event(3, "kernel.permission_decided", { decision: "allow", reason: "authority-allowed" }),
    event(4, "kernel.worker_started", { workerId: "codex-task" }),
    event(5, "kernel.guardrail_triggered", { action: "needs-decision", guardrailReason: "tool-calls" }),
    event(6, "task.needs_decision"),
  ]);
  const corrected = recordFor("corrected-completion", [
    event(1, "task.created"),
    event(2, "task.approved"),
    event(3, "kernel.permission_decided", { decision: "allow", reason: "authority-allowed" }),
    event(4, "kernel.worker_started", { workerId: "codex-task" }),
    event(5, "kernel.outcome_unverified", { outcomeStatus: "unverified" }),
    event(6, "task.needs_decision"),
    event(7, "user.correction", { kind: "scope-change" }),
    event(8, "task.approved"),
    event(9, "kernel.permission_decided", { decision: "allow", reason: "authority-allowed" }),
    event(10, "kernel.worker_started", { workerId: "codex-task" }),
    event(11, "kernel.outcome_verified", { outcomeStatus: "verified" }),
    event(12, "task.completed"),
  ]);

  for (const [record, fixture] of [
    [approvalPause, "approval-pause"],
    [stopCancel, "stop-cancel"],
    [completion, "verified-completion"],
    [guardrail, "guardrail-decision"],
    [corrected, "corrected-completion"],
  ] as const) {
    const replay = replayTrajectory(record, fixture);
    assert.equal(replay.status, "passed", `${fixture}: ${replay.violations.join("; ")}`);
    assert.equal(replay.toolExecutionCount, 0);
    assert.equal(replay.liveServiceCallCount, 0);
    assert.equal(replay.computerUseCallCount, 0);
  }
});

test("replay fails closed when a worker starts before approval", () => {
  const record = recordFor("verified-completion", [
    event(1, "task.created"),
    event(2, "kernel.worker_started", { workerId: "codex-task" }),
    event(3, "kernel.outcome_verified", { outcomeStatus: "verified" }),
    event(4, "task.completed"),
  ]);
  const replay = replayTrajectory(record, "verified-completion");
  assert.equal(replay.status, "failed");
  assert.ok(replay.violations.some((violation) => /without an allow decision/.test(violation)));
});

test("the shared Python fixture is valid for the TypeScript contract", async () => {
  const path = new URL("../reliability_lab/fixtures/trajectory-verified-completion.json", import.meta.url);
  const record = JSON.parse(await readFile(path, "utf8")) as TrajectoryRecord;
  assert.deepEqual(validateTrajectoryRecord(record), []);
  assert.equal(replayTrajectory(record, "verified-completion").status, "passed");
});
