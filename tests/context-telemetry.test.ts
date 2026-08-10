import assert from "node:assert/strict";
import test from "node:test";
import {
  measureContextSegment,
  recordContextSnapshot,
  tokenUsageDelta,
} from "../electron/context-telemetry.ts";

test("context measurements expose size and provenance without raw content", () => {
  const raw = "private prompt 🔒";
  const measured = measureContextSegment({
    name: "user_message",
    source: "conversation:send",
    provenance: "user",
    value: raw,
  });
  assert.equal(measured.measurement, "exact-visible");
  assert.equal(measured.chars, raw.length);
  assert.equal(measured.utf8Bytes, Buffer.byteLength(raw));
  assert.equal(measured.sha256?.length, 64);
  assert.doesNotMatch(JSON.stringify(measured), /private prompt/);
});

test("runtime-owned context remains explicitly unknown", () => {
  assert.deepEqual(
    measureContextSegment({
      name: "codex_runtime_inherited_context",
      source: "codex-app-server",
      provenance: "runtime",
    }),
    {
      name: "codex_runtime_inherited_context",
      source: "codex-app-server",
      provenance: "runtime",
      measurement: "unknown-runtime",
    },
  );
});

test("telemetry never breaks a request on non-serializable context", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(
    measureContextSegment({
      name: "future_payload",
      source: "fixture",
      provenance: "bmo",
      value: circular,
    }).measurement,
    "unavailable",
  );
});

test("context snapshots contain only metadata and exact visible totals", () => {
  const priorLog = console.log;
  console.log = () => {};
  try {
    const snapshot = recordContextSnapshot(
      "test",
      "turn.start",
      { input: "secret request" },
      [
        {
          name: "instruction",
          source: "fixture",
          provenance: "bmo",
          value: "abc",
        },
        {
          name: "history",
          source: "runtime",
          provenance: "history",
        },
      ],
    );
    assert.deepEqual(snapshot.visibleTotals, {
      segments: 1,
      chars: 3,
      utf8Bytes: 3,
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /secret request|"abc"/);
  } finally {
    console.log = priorLog;
  }
});

test("usage deltas preserve first snapshot and subtract cumulative updates", () => {
  const first = {
    inputTokens: 100,
    cachedInputTokens: 40,
    outputTokens: 10,
    reasoningOutputTokens: 3,
    totalTokens: 110,
  };
  const second = {
    inputTokens: 160,
    cachedInputTokens: 80,
    outputTokens: 15,
    reasoningOutputTokens: 5,
    totalTokens: 175,
  };
  assert.deepEqual(tokenUsageDelta(first), first);
  assert.deepEqual(tokenUsageDelta(second, first), {
    inputTokens: 60,
    cachedInputTokens: 40,
    outputTokens: 5,
    reasoningOutputTokens: 2,
    totalTokens: 65,
  });
});

test("usage deltas treat decreasing counters as a new baseline", () => {
  const previous = {
    inputTokens: 100,
    cachedInputTokens: 40,
    outputTokens: 10,
    reasoningOutputTokens: 3,
    totalTokens: 110,
  };
  const current = {
    inputTokens: 20,
    cachedInputTokens: 0,
    outputTokens: 2,
    reasoningOutputTokens: 0,
    totalTokens: 22,
  };
  assert.deepEqual(tokenUsageDelta(current, previous), current);
});
