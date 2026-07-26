import assert from "node:assert/strict";
import test from "node:test";
import { conciseSpeech, VoiceSession, type VoiceRecognitionPort } from "../src/voice-session.ts";
import { TaskRuntime, type ActivityLedger, type TaskExecutor } from "../electron/task-runtime.ts";

class FakeRecognition implements VoiceRecognitionPort {
  starts = 0;
  stops = 0;
  private result = (_transcript: string) => {};
  private error = (_message: string) => {};
  private end = () => {};

  start() { this.starts += 1; }
  stop() { this.stops += 1; }
  onResult(listener: (transcript: string) => void) { this.result = listener; return () => { this.result = () => {}; }; }
  onError(listener: (message: string) => void) { this.error = listener; return () => { this.error = () => {}; }; }
  onEnd(listener: () => void) { this.end = listener; return () => { this.end = () => {}; }; }
  say(text: string) { this.result(text); }
  fail(message: string) { this.error(message); }
  finish() { this.end(); }
}

test("push-to-talk visibly enters Listening before microphone transport and sends a goal", () => {
  const recognition = new FakeRecognition();
  const events: string[] = [];
  const session = new VoiceSession(recognition, (event) => events.push(event.type === "goal" ? `${event.type}:${event.goal}` : event.type));

  session.startPushToTalk();
  assert.deepEqual(events, ["listening"]);
  assert.equal(recognition.starts, 1);
  recognition.say("Hey BMO, open the requested page");

  assert.deepEqual(events, ["listening", "goal:open the requested page", "idle"]);
  assert.equal(recognition.stops, 1);
});

test("spoken Stop is a distinct owner interruption event", () => {
  const recognition = new FakeRecognition();
  const events: string[] = [];
  const session = new VoiceSession(recognition, (event) => events.push(event.type));

  session.startPushToTalk();
  recognition.say("Stop task");

  assert.deepEqual(events, ["listening", "stop", "idle"]);
});

test("a spoken Stop cancels the active Task and records revoked authority", async () => {
  const recognition = new FakeRecognition();
  const ledger: Record<string, unknown>[] = [];
  let signalReady: (() => void) | undefined;
  const signalStarted = new Promise<void>((resolve) => { signalReady = resolve; });
  const executor: TaskExecutor = {
    execute: async (_goal, signal) => await new Promise((_, reject) => {
      signalReady?.();
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  };
  const runtime = new TaskRuntime(executor, { append: async (event) => { ledger.push(event); } } satisfies ActivityLedger, () => {});
  const task = await runtime.create("Keep working until I stop you");
  const running = runtime.approve(task.id);
  await signalStarted;
  const session = new VoiceSession(recognition, (event) => {
    if (event.type === "stop") void runtime.cancel(task.id);
  });

  session.startPushToTalk();
  recognition.say("BMO, stop");
  await running;

  assert.equal(ledger.at(-1)?.type, "task.cancelled");
  assert.equal(ledger.at(-1)?.reason, "owner_stop");
});

test("voice transport failure becomes degraded without discarding the session", () => {
  const recognition = new FakeRecognition();
  const events: Array<{ type: string; message?: string }> = [];
  const session = new VoiceSession(recognition, (event) => events.push(event));

  session.startPushToTalk();
  recognition.fail("Microphone permission was denied.");

  assert.equal(session.currentStatus, "degraded");
  assert.deepEqual(events.at(-1), { type: "degraded", message: "Microphone permission was denied." });
});

test("spoken completion is concise for the Stage", () => {
  const long = `VERIFIED OUTCOME: ${"confirmed ".repeat(40)}`;
  assert.ok(conciseSpeech(long).length <= 220);
  assert.ok(!conciseSpeech(long).startsWith("VERIFIED OUTCOME:"));
});
