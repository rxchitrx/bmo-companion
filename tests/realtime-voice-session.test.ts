import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyRealtimeDataEvent,
  createMicrophoneConstraints,
  normalizeRealtimeTokenUsage,
} from "../src/realtime-voice-session.ts";

test("Codex realtime data events project into visible companion states", () => {
  assert.equal(
    classifyRealtimeDataEvent("input_audio_buffer.speech_started"),
    "listening",
  );
  assert.equal(
    classifyRealtimeDataEvent("input_audio_buffer.speech_stopped"),
    "thinking",
  );
  assert.equal(classifyRealtimeDataEvent("response.audio.delta"), "speaking");
  assert.equal(classifyRealtimeDataEvent("response.audio.done"), "connected");
  assert.equal(classifyRealtimeDataEvent("response.done"), "connected");
  assert.equal(classifyRealtimeDataEvent("unrelated.event"), null);
});

test("the chosen microphone is constrained without weakening voice processing", () => {
  assert.deepEqual(createMicrophoneConstraints("built-in-mic"), {
    deviceId: { exact: "built-in-mic" },
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  });
  assert.deepEqual(createMicrophoneConstraints(), {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  });
});

test("realtime usage updates normalize without retaining event contents", () => {
  assert.deepEqual(
    normalizeRealtimeTokenUsage({
      type: "session.usage.updated",
      usage: {
        input_tokens: 1200,
        input_token_details: { cached_tokens: 800 },
        output_tokens: 300,
        output_token_details: { reasoning_tokens: 40 },
        total_tokens: 1500,
      },
    }),
    {
      inputTokens: 1200,
      cachedInputTokens: 800,
      outputTokens: 300,
      reasoningOutputTokens: 40,
      totalTokens: 1500,
    },
  );
});

test("turn completion usage normalizes from the realtime turn envelope", () => {
  assert.deepEqual(
    normalizeRealtimeTokenUsage({
      type: "turn.done",
      turn: {
        usage: {
          input_tokens: 900,
          input_token_details: { cached_tokens: 600 },
          output_tokens: 100,
          total_tokens: 1000,
        },
      },
    }),
    {
      inputTokens: 900,
      cachedInputTokens: 600,
      outputTokens: 100,
      reasoningOutputTokens: 0,
      totalTokens: 1000,
    },
  );
});
