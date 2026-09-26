import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PiCodingTaskExecutor, piSandboxProfile } from "../electron/pi-coding-adapter.js";
import { allowTaskAuthority, createTaskAuthorityScope } from "../electron/permission-lifecycle.js";
import { ComputerUseHealth } from "../electron/computer-use-health.js";
import { MinimalExecutionKernel } from "../electron/execution-kernel.js";
import { createBmoTaskEngine } from "../electron/task-engine.js";
import { JsonlActivityLedger, JsonTaskStore, TaskRuntime } from "../electron/task-runtime.js";

const exec = promisify(execFile);
const original = process.cwd();
const outputArg = process.argv.indexOf("--output");
const output = outputArg >= 0
  ? join(original, process.argv[outputArg + 1] ?? "")
  : join(original, "outputs/evaluation/pi-coding-adapter-live-2026-09-26.json");
const throughRuntime = process.argv.includes("--through-runtime");
const base = await realpath(await mkdtemp(join(tmpdir(), "bmo-pi-live-")));
const project = join(base, "bmo");
await exec("git", ["clone", "-q", "--no-local", original, project], { timeout: 60_000 });
await symlink(join(original, "node_modules"), join(project, "node_modules"));
await writeFile(join(project, ".git", "info", "exclude"), "node_modules\n", { flag: "a" });
const goal = "In electron/diagnostics.ts, fix sanitizeDiagnostic so it redacts an access_token URL query parameter value, just like token, key, secret, and code. Change only electron/diagnostics.ts. Do not edit tests or package scripts. BMO will run verification after you finish.";
const progress: string[] = [];
const started = Date.now();
let result: { verified: boolean; summary: string; usage?: unknown; timing?: unknown };
let taskStatus: string | undefined;
let pendingBeforeApproval: boolean | undefined;
let ledgerEvents: string[] | undefined;
if (throughRuntime) {
  process.chdir(project);
  const engine = createBmoTaskEngine(new ComputerUseHealth(), join(base, "workspaces"));
  const ledgerPath = join(base, "activity.jsonl");
  const runtime = new TaskRuntime(
    new MinimalExecutionKernel(engine.taskExecutor),
    new JsonlActivityLedger(ledgerPath),
    (snapshot) => {
      for (const message of snapshot.progress.slice(progress.length)) {
        progress.push(message);
        process.stdout.write(`${message}\n`);
      }
    },
    undefined,
    new JsonTaskStore(join(base, "task.json")),
    engine.recoveryObserver,
  );
  const task = await runtime.create(goal, { kind: "coding", model: "gpt-6-luna", effort: "low" });
  pendingBeforeApproval = runtime.currentTask()?.status === "waiting_approval" &&
    !existsSync(join(base, "workspaces"));
  await runtime.approve(task.id);
  const snapshot = runtime.currentTask();
  taskStatus = snapshot?.status;
  result = {
    verified: snapshot?.status === "completed",
    summary: snapshot?.summary ?? "Task did not settle.",
    usage: snapshot?.usage,
    timing: snapshot?.timing,
  };
  ledgerEvents = (await readFile(ledgerPath, "utf8"))
    .trim().split("\n").map((line) => String((JSON.parse(line) as { type?: string }).type));
} else {
  const executor = new PiCodingTaskExecutor(join(base, "workspaces"), project);
  const controller = new AbortController();
  const taskId = randomUUID();
  const authority = allowTaskAuthority(
    createTaskAuthorityScope({ taskId, goal, taskKind: "coding" }),
    new Date(), new Date(Date.now() + 10 * 60_000), "authorized-live-evaluation",
  );
  result = await executor.execute(goal, controller.signal, (message) => {
    progress.push(message);
    process.stdout.write(`${message}\n`);
  }, undefined, undefined, { kind: "coding", model: "gpt-6-luna", effort: "low", taskId, authority });
}
const workspaceMessage = progress.find((message) => message.startsWith("Isolated code workspace: "));
const workspace = workspaceMessage?.slice("Isolated code workspace: ".length) ?? "";
let hiddenPass = false;
let hiddenDetail = "No workspace was created.";
if (workspace && existsSync(workspace)) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "bmo-pi-hidden-")));
  const profile = join(scratch, "verify.sb");
  await writeFile(profile, piSandboxProfile(await realpath(workspace), scratch, "", false));
  const source = await readFile(join(workspace, "electron/diagnostics.ts"), "utf8");
  const staticCheck = source.includes("access_token") && !source.includes("process.env") && !source.includes("child_process");
  try {
    const run = await exec("sandbox-exec", ["-f", profile, process.execPath, "--experimental-strip-types", "--input-type=module", "-e",
      "import {sanitizeDiagnostic} from './electron/diagnostics.ts'; const output=String(sanitizeDiagnostic('https://example.invalid/?access_token=privatevalue&x=1')); if(output.includes('privatevalue') || !output.includes('[REDACTED]') || !output.includes('x=1')) process.exit(1);"],
      { cwd: workspace, timeout: 30_000, env: { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: scratch, CI: "1" } });
    hiddenPass = staticCheck && run.stdout.length === 0;
    hiddenDetail = hiddenPass ? "Hidden access_token contract passed." : "Static contract failed.";
  } catch (error) {
    hiddenDetail = error instanceof Error ? error.message.slice(0, 500) : String(error);
  }
}
const report = {
  task: "BMO diagnostics access_token redaction",
  model: "gpt-6-luna",
  effort: "low",
  provider: "openai-codex subscription through Pi",
  route: throughRuntime ? "BMO TaskRuntime > execution kernel > task engine > Pi" : "Pi adapter directly",
  taskStatus,
  pendingBeforeApproval,
  ledgerEvents,
  adapterVerified: result.verified,
  hiddenPass,
  hiddenDetail,
  pass: result.verified && hiddenPass && (!throughRuntime || (
    pendingBeforeApproval === true && taskStatus === "completed" &&
    ["task.created", "task.approved", "task.completed"].every((event) => ledgerEvents?.includes(event))
  )),
  summary: result.summary,
  usage: result.usage,
  timing: result.timing,
  workspace,
  durationMs: Date.now() - started,
  sourceCheckoutUnchanged: (await exec("git", ["status", "--porcelain"], { cwd: project })).stdout.trim() === "",
};
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.pass) process.exitCode = 1;
