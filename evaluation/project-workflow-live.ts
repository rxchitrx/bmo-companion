import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
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
const outputArg = process.argv.indexOf("--output");
const output = resolve(outputArg >= 0 ? process.argv[outputArg + 1] ?? "outputs/evaluation/project-workflow-live.json" : "outputs/evaluation/project-workflow-live.json");
const base = await mkdtemp(join(tmpdir(), "bmo-python-project-live-"));
const root = join(base, "python-project");
await mkdir(join(root, "tests"), { recursive: true });
await writeFile(join(root, "tests", "__init__.py"), "");
await writeFile(join(root, "counter.py"), "def next_value(value):\n    return value - 1\n");
await writeFile(join(root, "tests", "test_counter.py"), "import unittest\nfrom counter import next_value\n\nclass CounterTests(unittest.TestCase):\n    def test_increment(self):\n        self.assertEqual(next_value(4), 5)\n");
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "BMO Eval", GIT_AUTHOR_EMAIL: "bmo@example.invalid", GIT_COMMITTER_NAME: "BMO Eval", GIT_COMMITTER_EMAIL: "bmo@example.invalid" };
const git = async (...args: string[]) => (await exec("git", args, { cwd: root, env: gitEnv })).stdout.trim();
await git("init", "-q"); await git("add", "."); await git("commit", "-qm", "base");
const registry = new ProjectRegistry(join(base, "projects.json"));
const saved = await registry.add(root, "Counter", "python-unittest", ["my Python project"]);
await registry.select("my Python project");
const project = await registry.snapshot();
const workspaces = join(base, "workspaces");
const engine = createBmoTaskEngine(new ComputerUseHealth(), workspaces);
const ledger = join(base, "activity.jsonl");
const runtime = new TaskRuntime(new MinimalExecutionKernel(engine.taskExecutor), new JsonlActivityLedger(ledger), () => {}, undefined, new JsonTaskStore(join(base, "task.json")), engine.recoveryObserver);
const task = await runtime.create("Fix counter.py so next_value increments its integer argument by one. Change only counter.py. BMO will run Python unittest after you finish.",
  { kind: "coding", model: "gpt-6-luna", effort: "low", project });
const pendingBeforeApproval = runtime.currentTask()?.status === "waiting_approval";
await runtime.approve(task.id);
const settled = runtime.currentTask();
const reviewService = new CodeReviewService(workspaces, join(base, "review.json"));
let diff = "", applied = false, hiddenPass = false, sourceUntouchedBeforeApply = false, restoredResult = false, error = "";
try {
  if (!settled) throw new Error("Task did not settle.");
  await reviewService.remember(settled);
  const restored = await new CodeReviewService(workspaces, join(base, "review.json")).task(settled.id);
  restoredResult = restored?.project?.id === saved.id && restored.codeReview?.digest === settled.codeReview?.digest;
  const review = await reviewService.review(restored!);
  diff = review.diff;
  sourceUntouchedBeforeApply = (await readFile(join(root, "counter.py"), "utf8")).includes("value - 1") && (await git("status", "--porcelain", "--untracked-files=all")) === "";
  if (settled.status === "completed") {
    await reviewService.apply(settled);
    applied = true;
    const run = await exec("python3", ["-B", "-m", "unittest", "discover", "-s", "tests"], { cwd: root, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    hiddenPass = run.stderr.includes("OK") && (await readFile(join(root, "counter.py"), "utf8")).includes("value + 1");
  }
} catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
const sourceStatus = await git("status", "--porcelain", "--untracked-files=all");
const report = { taskId: task.id, savedProjectId: saved.id, selectedByAlias: project.id === saved.id, pendingBeforeApproval,
  status: settled?.status, summary: settled?.summary, usage: settled?.usage, codeReview: settled?.codeReview,
  diff: diff.slice(0, 2000), applied, hiddenPass, sourceUntouchedBeforeApply, restoredResult, sourceStatus, error,
  ledgerEvents: (await readFile(ledger, "utf8")).trim().split("\n").map((line) => JSON.parse(line).type),
  pass: pendingBeforeApproval && settled?.status === "completed" && !!settled.codeReview?.verification?.passed && restoredResult && sourceUntouchedBeforeApply && applied && hiddenPass && sourceStatus.trim() === "M counter.py" };
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.pass) process.exitCode = 1;
