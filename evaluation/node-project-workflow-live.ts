import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ProjectRegistry } from "../electron/project-registry.js";
import { CodeReviewService } from "../electron/code-review.js";
import { ComputerUseHealth } from "../electron/computer-use-health.js";
import { MinimalExecutionKernel } from "../electron/execution-kernel.js";
import { createBmoTaskEngine } from "../electron/task-engine.js";
import { JsonlActivityLedger, JsonTaskStore, TaskRuntime } from "../electron/task-runtime.js";

const exec = promisify(execFile);
const base = await mkdtemp(join(tmpdir(), "bmo-node-project-live-"));
const root = join(base, "node-project");
await mkdir(root);
await writeFile(join(root, "package.json"), JSON.stringify({ name: "bmo-node-live", private: true, type: "module", scripts: { test: "node --test" } }) + "\n");
await writeFile(join(root, "counter.js"), "export function nextValue(value) { return value - 1; }\n");
await writeFile(join(root, "counter.test.js"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { nextValue } from './counter.js';\ntest('increments', () => assert.equal(nextValue(4), 5));\n");
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "BMO Eval", GIT_AUTHOR_EMAIL: "bmo@example.invalid", GIT_COMMITTER_NAME: "BMO Eval", GIT_COMMITTER_EMAIL: "bmo@example.invalid" };
const git = async (...args: string[]) => (await exec("git", args, { cwd: root, env: gitEnv })).stdout.trim();
await git("init", "-q"); await git("add", "."); await git("commit", "-qm", "base");
const registry = new ProjectRegistry(join(base, "projects.json"));
const saved = await registry.add(root, "Counter JS", "npm-test", ["my JavaScript project"]);
await registry.select("my JavaScript project");
const project = await registry.snapshot();
const workspaces = join(base, "workspaces");
const engine = createBmoTaskEngine(new ComputerUseHealth(), workspaces);
const ledger = join(base, "activity.jsonl");
const runtime = new TaskRuntime(new MinimalExecutionKernel(engine.taskExecutor), new JsonlActivityLedger(ledger), () => {}, undefined, new JsonTaskStore(join(base, "task.json")), engine.recoveryObserver);
const task = await runtime.create("Fix counter.js so nextValue increments its integer argument by one. Change only counter.js. BMO will run npm test after you finish.",
  { kind: "coding", model: "gpt-6-luna", effort: "low", project });
const pendingBeforeApproval = runtime.currentTask()?.status === "waiting_approval";
await runtime.approve(task.id);
const settled = runtime.currentTask();
const reviewService = new CodeReviewService(workspaces, join(base, "review.json"));
let sourceUntouchedBeforeApply = false, applied = false, hiddenPass = false, error = "";
try {
  if (!settled) throw new Error("Task did not settle.");
  const review = await reviewService.review(settled);
  sourceUntouchedBeforeApply = (await readFile(join(root, "counter.js"), "utf8")).includes("value - 1") && (await git("status", "--porcelain")) === "";
  if (settled.status === "completed" && review.verified) {
    await reviewService.apply(settled);
    applied = true;
    const run = await exec("npm", ["test"], { cwd: root, env: { ...process.env, CI: "1" } });
    hiddenPass = run.stdout.includes("# pass 1") && (await readFile(join(root, "counter.js"), "utf8")).includes("value + 1");
  }
} catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
const report = { taskId: task.id, savedProjectId: saved.id, selectedByAlias: project.id === saved.id, pendingBeforeApproval,
  status: settled?.status, usage: settled?.usage, codeReview: settled?.codeReview, sourceUntouchedBeforeApply, applied, hiddenPass, error,
  sourceStatus: await git("status", "--porcelain"),
  ledgerEvents: (await readFile(ledger, "utf8")).trim().split("\n").map((line) => JSON.parse(line).type),
  pass: pendingBeforeApproval && settled?.status === "completed" && !!settled.codeReview?.verification?.passed && sourceUntouchedBeforeApply && applied && hiddenPass };
const output = resolve(process.argv[2] ?? "outputs/evaluation/node-project-workflow-live.json");
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.pass) process.exitCode = 1;
