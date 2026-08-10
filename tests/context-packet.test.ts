import assert from "node:assert/strict";
import test from "node:test";
import {
  TASK_CONTEXT_MAX_CHARS,
  TASK_GOAL_MAX_CHARS,
  TASK_HISTORY_MAX_CHARS,
  boundHistorySummary,
  contextPacketTelemetrySegments,
  createTaskContextPacket,
  renderTaskContextPacket,
} from "../electron/context-packet.ts";

test("a task packet contains only its purpose and task-kind capability reference", () => {
  const packet = createTaskContextPacket({
    goal: "Fix the focused failing test",
    kind: "coding",
  });

  assert.equal(packet.purpose.objective, "Fix the focused failing test");
  assert.deepEqual(packet.relevantContext, []);
  assert.deepEqual(packet.capabilityReferences.map((item) => item.id), [
    "codex.workspace",
  ]);
  assert.equal(packet.historyPolicy.rawHistoryIncluded, false);
  assert.equal(packet.manifest.length, 1);
  assert.equal(packet.budget.maxContentChars, TASK_CONTEXT_MAX_CHARS);
  assert.doesNotMatch(renderTaskContextPacket(packet), /connector catalog|ambient history/i);
});

test("retry packets include only a bounded existing outcome summary", () => {
  const priorOutcome = `start ${"private history ".repeat(300)} end ✅`;
  const packet = createTaskContextPacket({
    goal: "Retry without duplicating completed work",
    kind: "computer",
    retryOf: "task-previous",
    priorOutcome,
  });
  const history = packet.relevantContext[0];

  assert.equal(history?.kind, "bounded_history_summary");
  assert.equal(history?.trust, "untrusted_data");
  assert.ok((history?.content.length ?? Infinity) <= TASK_HISTORY_MAX_CHARS);
  assert.match(history?.content ?? "", /^start/);
  assert.match(history?.content ?? "", /end ✅$/);
  assert.equal(packet.manifest[1]?.truncated, true);
  assert.equal(packet.budget.usedContentChars,
    packet.purpose.objective.length + (history?.content.length ?? 0));
  assert.deepEqual(packet.capabilityReferences.map((item) => item.id), [
    "codex.computer_use",
  ]);
});

test("history bounds remove nulls and do not split unicode surrogate pairs", () => {
  const bounded = boundHistorySummary(`${"a".repeat(1_600)}\0${"🙂".repeat(500)}`);
  assert.ok(bounded.content.length <= TASK_HISTORY_MAX_CHARS);
  assert.doesNotMatch(bounded.content, /\0/);
  assert.equal(Array.from(bounded.content).some((char) =>
    char.length === 1 && char.charCodeAt(0) >= 0xD800 && char.charCodeAt(0) <= 0xDFFF), false);
  assert.match(bounded.content, /🙂$/);
  assert.equal(boundHistorySummary("abcdef", 3).content, "abc");
});

test("oversized task goals are rejected instead of silently truncated", () => {
  assert.throws(
    () => createTaskContextPacket({ goal: "x".repeat(TASK_GOAL_MAX_CHARS + 1) }),
    /Context Packet limit/,
  );
});

test("packet telemetry exposes manifest metadata but never raw context", () => {
  const secretGoal = "private task objective";
  const packet = createTaskContextPacket({
    goal: secretGoal,
    retryOf: "task-1",
    priorOutcome: "private prior outcome",
  });
  const segments = contextPacketTelemetrySegments(packet);
  const metadataOnly = segments.map(({ value: _value, ...segment }) => segment);

  assert.equal(segments.length, 2);
  assert.equal(metadataOnly[0]?.inclusionReason,
    "The worker needs the approved Task objective.");
  assert.equal(metadataOnly[1]?.budgetChars, TASK_HISTORY_MAX_CHARS);
  assert.doesNotMatch(JSON.stringify(metadataOnly), /private task|private prior/);
});
