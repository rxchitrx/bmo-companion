import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CodexTaskExecutor } from "../electron/codex-adapter.js";
import { codeWorkerEnvironment, createCodeWorkspace } from "../electron/code-workspace.js";

const exec = promisify(execFile);
const model = "gpt-6-luna";
const effort = "low";
type Arm = "pi" | "codex" | "codex-cli";
type Case = { id: string; goal: string; files: Record<string, string>; hiddenTest: string };

const cases: Case[] = [
  {
    id: "range-bug",
    goal: "Fix sumRange(start, end) in src/range.js. It must include both integer endpoints, accept reversed bounds, support negative values, and throw TypeError for non-integer inputs. Run npm test and verify the result.",
    files: {
      "package.json": JSON.stringify({ name: "range-fixture", private: true, scripts: { test: "node --test" } }, null, 2) + "\n",
      "src/range.js": "function sumRange(start, end) {\n  let total = 0;\n  for (let value = start; value < end; value++) total += value;\n  return total;\n}\nmodule.exports = { sumRange };\n",
      "test/range.test.js": "const test = require('node:test'); const assert = require('node:assert/strict'); const { sumRange } = require('../src/range');\ntest('forward inclusive range', () => assert.equal(sumRange(1, 3), 6));\ntest('single value', () => assert.equal(sumRange(5, 5), 5));\n",
    },
    hiddenTest: "const test = require('node:test'); const assert = require('node:assert/strict'); const { sumRange } = require('../src/range');\ntest('reversed and negative ranges', () => { assert.equal(sumRange(3, 1), 6); assert.equal(sumRange(-2, 2), 0); });\ntest('invalid inputs', () => { assert.throws(() => sumRange(1.5, 2), TypeError); assert.throws(() => sumRange(1, NaN), TypeError); });\n",
  },
  {
    id: "unique-api",
    goal: "Implement uniqueBy(items, keyFn) in src/unique.js. Return a new array containing the first item for each key, preserving order. Do not mutate the input. Use JavaScript key identity, including object keys. Throw TypeError unless items is an array and keyFn is a function. Run npm test and verify the result.",
    files: {
      "package.json": JSON.stringify({ name: "unique-fixture", private: true, scripts: { test: "node --test" } }, null, 2) + "\n",
      "src/unique.js": "function uniqueBy(items, keyFn) {\n  return items;\n}\nmodule.exports = { uniqueBy };\n",
      "test/unique.test.js": "const test = require('node:test'); const assert = require('node:assert/strict'); const { uniqueBy } = require('../src/unique');\ntest('keeps first matching item', () => { const values = [{ id: 1, name: 'a' }, { id: 1, name: 'b' }, { id: 2, name: 'c' }]; assert.deepEqual(uniqueBy(values, x => x.id), [values[0], values[2]]); });\n",
    },
    hiddenTest: "const test = require('node:test'); const assert = require('node:assert/strict'); const { uniqueBy } = require('../src/unique');\ntest('object key identity and no mutation', () => { const key = {}; const other = {}; const input = [{ k: key }, { k: key }, { k: other }]; const out = uniqueBy(input, x => x.k); assert.deepEqual(out, [input[0], input[2]]); assert.notEqual(out, input); assert.equal(input.length, 3); });\ntest('invalid arguments', () => { assert.throws(() => uniqueBy(null, x => x), TypeError); assert.throws(() => uniqueBy([], null), TypeError); });\n",
  },
  {
    id: "cart-two-file",
    goal: "Fix the cart checkout in src/cart.js and src/money.js. subtotalCents(items) must sum each item's integer unitPriceCents times integer quantity, reject negative or non-integer values with TypeError, and never mutate items. totalCents(items, discountCents) must subtract a nonnegative integer discount, clamp at zero, and reject invalid discounts with TypeError. Keep the exported function names and run npm test.",
    files: {
      "package.json": JSON.stringify({ name: "cart-fixture", private: true, scripts: { test: "node --test" } }, null, 2) + "\n",
      "src/money.js": "function subtotalCents(items) {\n  return items.reduce((sum, item) => sum + item.unitPriceCents, 0);\n}\nmodule.exports = { subtotalCents };\n",
      "src/cart.js": "const { subtotalCents } = require('./money');\nfunction totalCents(items, discountCents = 0) {\n  return subtotalCents(items) - discountCents;\n}\nmodule.exports = { totalCents };\n",
      "test/cart.test.js": "const test = require('node:test'); const assert = require('node:assert/strict'); const { subtotalCents } = require('../src/money'); const { totalCents } = require('../src/cart');\ntest('quantities and discount', () => { const items = [{ unitPriceCents: 125, quantity: 2 }, { unitPriceCents: 50, quantity: 1 }]; assert.equal(subtotalCents(items), 300); assert.equal(totalCents(items, 75), 225); });\n",
    },
    hiddenTest: "const test = require('node:test'); const assert = require('node:assert/strict'); const { subtotalCents } = require('../src/money'); const { totalCents } = require('../src/cart');\ntest('clamp and empty cart', () => { assert.equal(totalCents([{ unitPriceCents: 20, quantity: 1 }], 50), 0); assert.equal(subtotalCents([]), 0); });\ntest('invalid money and quantity', () => { assert.throws(() => subtotalCents([{ unitPriceCents: -1, quantity: 1 }]), TypeError); assert.throws(() => subtotalCents([{ unitPriceCents: 10, quantity: 1.2 }]), TypeError); assert.throws(() => totalCents([], -1), TypeError); assert.throws(() => totalCents([], 1.5), TypeError); });\n",
  },
];

function arg(name: string, fallback: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
}
const repeat = Number(arg("--repeat", "3"));
if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 10) throw new Error("--repeat must be 1-10");
const selected = arg("--cases", cases.map((value) => value.id).join(",")).split(",");
const arms = arg("--arms", "pi,codex").split(",") as Arm[];
if (selected.some((id) => !cases.some((value) => value.id === id)) || arms.some((arm) => !["pi", "codex", "codex-cli"].includes(arm))) throw new Error("Unknown case or arm");
const output = arg("--output", join(process.cwd(), "outputs/evaluation/coding-agent-comparison-2026-09-26.json"));
const piPath = process.env.PI_CLI_PATH ?? "pi";
const maxRunMs = 240_000;
const taskRoot = await mkdtemp(join(tmpdir(), "bmo-coding-compare-"));
const runCommand = async (cwd: string, command: string, args: string[]) =>
  exec(command, args, { cwd, timeout: 30_000, maxBuffer: 2_000_000 });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function seed(testCase: Case, name: string) {
  const root = join(taskRoot, name);
  for (const [path, content] of Object.entries(testCase.files)) {
    await mkdir(join(root, path.split("/").slice(0, -1).join("/")), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await runCommand(root, "git", ["init", "-q"]);
  await runCommand(root, "git", ["add", "."]);
  await runCommand(root, "git", ["-c", "user.name=BMO Lab", "-c", "user.email=bmo-lab@example.invalid", "commit", "-qm", "seed"]);
  return root;
}

async function runPi(cwd: string, goal: string) {
  const args = ["--mode", "json", "--no-session", "--provider", "openai-codex", "--model", model,
    "--thinking", effort, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
    "--tools", "read,bash,edit,write",
    `You are BMO's coding worker. Work only inside the current Git worktree. Inspect the code, make the requested change, run npm test, and verify the result. Do not access anything outside this worktree. End with VERIFIED OUTCOME: if you verified it, otherwise UNVERIFIED:. Task: ${goal}`];
  const started = Date.now();
  const child = spawn(piPath, args, { cwd, env: codeWorkerEnvironment(process.env), stdio: ["ignore", "pipe", "pipe"], detached: true });
  let buffer = "";
  let stderr = "";
  let input = 0, cachedInput = 0, cacheWrite = 0, output = 0, toolCalls = 0, settled = false, finalText = "", error = "", transientError = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const event = JSON.parse(line) as Record<string, any>;
        if (event.type === "tool_execution_start") toolCalls += 1;
        if (event.type === "agent_settled") settled = true;
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const usage = event.message.usage;
          if (usage) { input += Number(usage.input ?? 0) + Number(usage.cacheRead ?? 0) + Number(usage.cacheWrite ?? 0); cachedInput += Number(usage.cacheRead ?? 0); cacheWrite += Number(usage.cacheWrite ?? 0); output += Number(usage.output ?? 0); }
          finalText = (event.message.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
          if (event.message.stopReason === "error") transientError = String(event.message.errorMessage ?? "provider error");
        }
      } catch { error = "invalid JSON event"; }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
  const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, maxRunMs);
  const exitCode = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  clearTimeout(timer);
  return { elapsedMs: Date.now() - started, inputTokens: input || null, cachedInputTokens: cachedInput || 0, cacheWriteTokens: cacheWrite || 0,
    outputTokens: output || null, toolCalls, settled, exitCode, claimedVerified: finalText.trimStart().startsWith("VERIFIED OUTCOME:"),
    finalTextDigest: sha(finalText), finalTextSnippet: finalText.slice(0, 300),
    transientError: transientError || undefined,
    error: error || (exitCode === 0 && settled ? undefined : stderr.slice(-500) || "Pi did not settle cleanly.") };
}

async function runCodex(root: string, goal: string, workspacesDirectory: string) {
  const previous = process.cwd();
  process.chdir(root);
  try {
    const executor = new CodexTaskExecutor(undefined, workspacesDirectory);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), maxRunMs);
    let workspace = "";
    let toolCalls = 0;
    const started = Date.now();
    try {
      const result = await executor.execute(goal, controller.signal, (progress) => {
        if (progress.startsWith("Isolated code workspace: ")) workspace = progress.slice("Isolated code workspace: ".length);
      }, undefined, undefined, { taskId: randomUUID(), kind: "coding", model, effort,
        budgetObserver: (event) => { if (event.type === "tool-started") toolCalls += 1; } });
      return { workspace, elapsedMs: Date.now() - started, inputTokens: result.usage?.inputTokens ?? null,
        cachedInputTokens: result.usage?.cachedInputTokens ?? 0, cacheWriteTokens: 0, outputTokens: result.usage?.outputTokens ?? null,
        toolCalls, settled: true, exitCode: 0, claimedVerified: result.verified,
        finalTextDigest: sha(result.summary), finalTextSnippet: result.summary.slice(0, 300), error: result.verified ? undefined : result.summary.slice(0, 500) };
    } catch (error) {
      return { workspace, elapsedMs: Date.now() - started, inputTokens: null, cachedInputTokens: 0, cacheWriteTokens: 0,
        outputTokens: null, toolCalls, settled: false, exitCode: 1, claimedVerified: false,
        finalTextDigest: "", finalTextSnippet: "", error: String(error).slice(0, 500) };
    } finally { clearTimeout(timer); }
  } finally { process.chdir(previous); }
}

async function runCodexCli(cwd: string, goal: string) {
  const codex = process.env.CODEX_CLI_PATH ?? "/Applications/ChatGPT.app/Contents/Resources/codex";
  const args = ["exec", "-m", model, "-c", `model_reasoning_effort=${effort}`,
    "-c", "approval_policy=never", "-s", "workspace-write", "-C", cwd,
    "--ephemeral", "--json", `${goal} Work only inside this isolated Git worktree.`];
  const started = Date.now();
  const child = spawn(codex, args, { cwd, env: codeWorkerEnvironment(process.env), stdio: ["ignore", "pipe", "pipe"], detached: true });
  let buffer = "", stderr = "", finalText = "", toolCalls = 0;
  let input: number | null = null, cachedInput = 0, output: number | null = null;
  let settled = false, error = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const event = JSON.parse(line) as Record<string, any>;
        if (event.type === "item.started" && ["command_execution", "file_change", "mcp_tool_call"].includes(event.item?.type)) toolCalls += 1;
        if (event.type === "item.completed" && event.item?.type === "agent_message") finalText = String(event.item.text ?? "");
        if (event.type === "turn.completed") {
          settled = true;
          input = Number(event.usage?.input_tokens ?? 0) || null;
          cachedInput = Number(event.usage?.cached_input_tokens ?? 0);
          output = Number(event.usage?.output_tokens ?? 0) || null;
        }
        if (event.type === "turn.failed") error = String(event.error?.message ?? "turn failed");
      } catch { error = "invalid JSON event"; }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
  const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, maxRunMs);
  const exitCode = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  clearTimeout(timer);
  return { elapsedMs: Date.now() - started, inputTokens: input, cachedInputTokens: cachedInput,
    cacheWriteTokens: 0, outputTokens: output, toolCalls, settled, exitCode,
    claimedVerified: false, finalTextDigest: sha(finalText), finalTextSnippet: finalText.slice(0, 300),
    error: error || (exitCode === 0 ? undefined : stderr.slice(-500)) };
}

const report: { schemaVersion: string; model: string; effort: string; piVersion: string; codexVersion: string;
  taskRoot: string; runTimeoutMs: number; runs: Array<Record<string, unknown>> } = {
  schemaVersion: "bmo-coding-agent-comparison/1", model, effort,
  piVersion: (await runCommand(process.cwd(), piPath, ["--version"])).stdout.trim(),
  codexVersion: (await runCommand(process.cwd(), process.env.CODEX_CLI_PATH ?? "/Applications/ChatGPT.app/Contents/Resources/codex", ["--version"])).stdout.trim(),
  taskRoot, runTimeoutMs: maxRunMs, runs: [],
};
async function save() { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + "\n"); }

for (const testCase of cases.filter((value) => selected.includes(value.id))) {
  for (let repetition = 1; repetition <= repeat; repetition++) {
    for (const arm of (repetition % 2 ? arms : [...arms].reverse())) {
      const name = `${testCase.id}-${repetition}-${arm}`;
      const root = await seed(testCase, name);
      const workspacesDirectory = join(taskRoot, "worktrees");
      let workspace = "";
      let worker: Record<string, unknown>;
      if (arm === "pi" || arm === "codex-cli") {
        workspace = await createCodeWorkspace(root, name, workspacesDirectory);
        worker = arm === "pi" ? await runPi(workspace, testCase.goal) : await runCodexCli(workspace, testCase.goal);
      } else {
        const outcome = await runCodex(root, testCase.goal, workspacesDirectory);
        workspace = outcome.workspace;
        worker = outcome;
      }
      let visiblePassed = false, hiddenPassed = false, changedFiles: string[] = [], sourceUntouched = false;
      let graderError = "";
      try {
        sourceUntouched = !(await runCommand(root, "git", ["status", "--porcelain", "--untracked-files=all"])).stdout.trim();
        if (workspace) {
          changedFiles = (await runCommand(workspace, "git", ["status", "--porcelain", "--untracked-files=all"])).stdout.trim().split("\n").filter(Boolean);
          try { visiblePassed = (await runCommand(workspace, "npm", ["test"])).stdout.includes("# fail 0"); }
          catch (error) { graderError = `Visible tests: ${String(error).slice(0, 220)}`; }
          await writeFile(join(workspace, "test", "hidden.test.js"), testCase.hiddenTest);
          try { hiddenPassed = (await runCommand(workspace, "npm", ["test"])).stdout.includes("# fail 0"); }
          catch (error) { graderError += ` Hidden tests: ${String(error).slice(0, 220)}`; }
        }
      } catch (error) { graderError = String(error).slice(0, 500); }
      const entry = { caseId: testCase.id, repetition, arm, model, effort, workspace,
        ...worker, sourceUntouched, changedFiles, visiblePassed, hiddenPassed, graderError: graderError || undefined };
      report.runs.push(entry);
      await save();
      process.stderr.write(`${name}: ${hiddenPassed ? "PASS" : "FAIL"}, input=${worker.inputTokens ?? "missing"}, ms=${worker.elapsedMs}\n`);
    }
  }
}
process.stdout.write(`${JSON.stringify({ output, runs: report.runs.length, taskRoot })}\n`);
