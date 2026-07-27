import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyRealtimeDataEvent,
  createMicrophoneConstraints,
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
