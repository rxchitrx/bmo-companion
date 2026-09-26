import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerUseHealth } from "../electron/computer-use-health.ts";
import { MinimalExecutionKernel } from "../electron/execution-kernel.ts";
import { DEFAULT_MODEL_SETTINGS, ModelSettingsStore } from "../electron/model-settings.ts";
import { createBmoTaskEngine } from "../electron/task-engine.ts";
import { TaskRuntime, type RecoveryObserver, type TaskExecutor } from "../electron/task-runtime.ts";

test("BMO routes coding through Pi and other Tasks through Codex", async () => {
  const calls: string[] = [];
  const pi: TaskExecutor = { async execute() { calls.push("pi"); return { summary: "VERIFIED OUTCOME: pi", verified: true }; } };
  const codex: TaskExecutor = { async execute() { calls.push("codex"); return { summary: "VERIFIED OUTCOME: codex", verified: true }; } };
  const recovery: RecoveryObserver = { async observe() { return { scopeStillMatches: true }; } };
  const engine = createBmoTaskEngine(new ComputerUseHealth(), "/tmp", { piExecutor: pi, codexExecutor: codex, codexRecovery: recovery });
  await engine.taskExecutor.execute("code", new AbortController().signal, () => {}, undefined, undefined, { kind: "coding" });
  await engine.taskExecutor.execute("general", new AbortController().signal, () => {}, undefined, undefined, { kind: "general" });
  assert.deepEqual(calls, ["pi", "codex"]);
  const codingRecovery = await engine.recoveryObserver.observe({ id: "1", goal: "code", kind: "coding", status: "suspended", state: "approval", progress: [] });
  assert.equal(codingRecovery.scopeStillMatches, false);
  assert.match(codingRecovery.detail ?? "", /will not replay/);
  const generalRecovery = await engine.recoveryObserver.observe({ id: "2", goal: "other", kind: "general", status: "suspended", state: "approval", progress: [] });
  assert.equal(generalRecovery.scopeStillMatches, true);
});

test("legacy coding default migrates to the tested Luna low selection", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "bmo-model-migration-"));
  context.after(() => rm(base, { recursive: true, force: true }));
  const path = join(base, "models.json");
  await writeFile(path, JSON.stringify({ coding: { model: "gpt-5.6-sol", effort: "high" } }));
  const store = new ModelSettingsStore(path);
  await store.load();
  assert.deepEqual(store.selection("coding"), { model: "gpt-6-luna", effort: "low" });
  assert.deepEqual(DEFAULT_MODEL_SETTINGS.coding, { model: "gpt-6-luna", effort: "low" });
  assert.match(await readFile(path, "utf8"), /gpt-5.6-sol/);
});

test("approved coding Task reaches Pi through BMO's kernel and activity lifecycle", async () => {
  let calls = 0;
  const pi: TaskExecutor = { async execute(_goal, _signal, _progress, _usage, _account, execution) {
    calls += 1;
    assert.equal(execution?.kind, "coding");
    assert.equal(execution?.model, "gpt-6-luna");
    assert.equal(execution?.contextPacket?.purpose.taskKind, "coding");
    return { summary: "VERIFIED OUTCOME: project tests passed", verified: true,
      verificationEvidence: [{ id: "pi.original-tests", kind: "tool-result", source: "bmo-pi-verifier", polarity: "supports", strength: "direct", statement: "Original tests passed." }] };
  } };
  const engine = createBmoTaskEngine(new ComputerUseHealth(), "/tmp", { piExecutor: pi });
  const events: string[] = [];
  const runtime = new TaskRuntime(new MinimalExecutionKernel(engine.taskExecutor), { async append(event) { events.push(String(event.type)); } }, () => {});
  const task = await runtime.create("Fix the code", { kind: "coding", model: "gpt-6-luna", effort: "low" });
  assert.equal(calls, 0);
  assert.equal(runtime.currentTask()?.status, "waiting_approval");
  await runtime.approve(task.id);
  assert.equal(calls, 1);
  assert.equal(runtime.currentTask()?.status, "completed");
  assert.ok(events.length > 0);
});
