import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { workspaceState } from "./pi-coding-adapter.js";
import type { TaskSnapshot } from "./task-runtime.js";

const exec = promisify(execFile);
async function git(cwd: string, args: string[]) {
  return (await exec("git", args, { cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
}
type ReviewState = "applying" | "applied" | "discarded";
export interface CodeReview { taskId: string; projectName: string; root: string; workspace: string; changed: string[]; diff: string; verified: boolean; verification?: { label: string; exitCode: number | null; output: string; passed: boolean }; state?: ReviewState; }

export class CodeReviewService {
  constructor(private readonly workspacesDirectory: string, private readonly journalPath: string) {}
  private indexWrite: Promise<void> = Promise.resolve();

  private async journal(): Promise<Record<string, ReviewState>> {
    try { return JSON.parse(await readFile(this.journalPath, "utf8")) as Record<string, ReviewState>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  }
  private get indexPath() { return `${this.journalPath}.results`; }
  private async index(): Promise<Record<string, TaskSnapshot>> {
    try { return JSON.parse(await readFile(this.indexPath, "utf8")) as Record<string, TaskSnapshot>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  }
  remember(task: TaskSnapshot): Promise<void> {
    if (task.kind !== "coding" || !task.project || !task.codeReview) return Promise.resolve();
    const write = async () => {
      const data = await this.index();
      data[task.id] = { id: task.id, goal: task.goal, status: task.status, state: task.state, progress: [], kind: "coding", project: task.project, codeReview: task.codeReview, summary: task.summary };
      await mkdir(dirname(this.indexPath), { recursive: true });
      const temp = `${this.indexPath}.${randomUUID()}.tmp`;
      await writeFile(temp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
      await rename(temp, this.indexPath);
    };
    const pending = this.indexWrite.then(write, write);
    this.indexWrite = pending.catch(() => {});
    return pending;
  }
  async task(id: string) { await this.indexWrite; return (await this.index())[id]; }
  async list() {
    await this.indexWrite;
    const [tasks, states] = await Promise.all([this.index(), this.journal()]);
    return Object.values(tasks).map((task) => ({ id: task.id, projectName: task.project?.name ?? "Project", summary: task.summary, state: states[task.id], status: task.status }));
  }
  private async mark(taskId: string, state: ReviewState) {
    const data = await this.journal(); data[taskId] = state;
    await mkdir(dirname(this.journalPath), { recursive: true });
    const temp = `${this.journalPath}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    await rename(temp, this.journalPath);
  }
  private async locate(task: TaskSnapshot) {
    if (task.kind !== "coding" || !task.project || !task.codeReview || !/^[a-f0-9-]{36}$/.test(task.id)) throw new Error("No code result is available for review.");
    const workspace = join(this.workspacesDirectory, task.id);
    const actual = await realpath(workspace);
    const parent = await realpath(this.workspacesDirectory);
    if (dirname(actual) !== parent) throw new Error("Code worktree moved outside BMO's workspace directory.");
    const registered = await git(task.project.root, ["worktree", "list", "--porcelain"]);
    if (!registered.split("\n").includes(`worktree ${actual}`)) throw new Error("Code worktree is no longer registered with this project.");
    return { workspace: actual, project: task.project, review: task.codeReview };
  }
  async review(task: TaskSnapshot): Promise<CodeReview> {
    const state = (await this.journal())[task.id];
    if (state === "discarded" && task.project && task.codeReview) {
      return { taskId: task.id, projectName: task.project.name, root: task.project.root, workspace: "", changed: task.codeReview.changed,
        diff: "This isolated result was discarded.", verified: task.status === "completed", verification: task.codeReview.verification, state };
    }
    const { workspace, project, review } = await this.locate(task);
    const current = await workspaceState(workspace);
    if (current.digest !== review.digest) throw new Error("Code worktree changed since verification. Review and verify it again before applying.");
    const diff = await git(workspace, ["diff", "--binary", "HEAD"]);
    const untracked = (await git(workspace, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    const preview = [diff, ...await Promise.all(untracked.map(async (path) => {
      const target = await realpath(join(workspace, path));
      if (!target.startsWith(`${workspace}/`) || !(await lstat(target)).isFile()) throw new Error("Unsafe new file in code result.");
      const data = await readFile(target, "utf8");
      return `\n--- /dev/null\n+++ b/${path}\n${data.slice(0, 10_000)}${data.length > 10_000 ? "\n[preview truncated]" : ""}`;
    }))].join("").slice(0, 100_000);
    return { taskId: task.id, projectName: project.name, root: project.root, workspace, changed: current.changed, diff: preview,
      verified: task.status === "completed", verification: review.verification, state };
  }
  async apply(task: TaskSnapshot) {
    if (task.status !== "completed") throw new Error("Only a verified completed code Task can be applied.");
    const review = await this.review(task);
    if (review.state) throw new Error("This code result was already applied, discarded, or interrupted. Inspect the project before another action.");
    const project = task.project!;
    if (await realpath(project.root) !== project.root || !isAbsolute(project.root)) throw new Error("Project folder changed.");
    if ((await git(project.root, ["rev-parse", "HEAD"])).trim() !== project.baseCommit) throw new Error("Project commit changed since approval.");
    if ((await git(project.root, ["status", "--porcelain", "--untracked-files=all"])).trim()) throw new Error("Project checkout has changes. Apply is paused to protect them.");
    const patch = await git(review.workspace, ["diff", "--binary", "HEAD"]);
    const newFiles = (await git(review.workspace, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    for (const path of newFiles) {
      const source = await realpath(join(review.workspace, path));
      if (!source.startsWith(`${review.workspace}/`) || !(await lstat(source)).isFile()) throw new Error("Unsafe new file in code result.");
      const target = resolve(project.root, path);
      if (relative(project.root, target).startsWith("..") || target === project.root) throw new Error("Unsafe destination path.");
      try { await lstat(target); throw new Error(`Destination already exists: ${path}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const scratch = await mkdtemp(join(tmpdir(), "bmo-code-apply-"));
    const patchPath = join(scratch, "result.patch");
    try {
    if (patch) {
      await writeFile(patchPath, patch);
      await git(project.root, ["apply", "--check", "--binary", patchPath]);
    }
    await this.mark(task.id, "applying");
    try {
      if (patch) await git(project.root, ["apply", "--binary", patchPath]);
      for (const path of newFiles) {
        const target = join(project.root, path);
        await mkdir(dirname(target), { recursive: true });
        if (!(await realpath(dirname(target))).startsWith(`${project.root}/`)) throw new Error("Destination parent moved outside project.");
        await copyFile(join(review.workspace, path), target, constants.COPYFILE_EXCL);
      }
      await this.mark(task.id, "applied");
      return { applied: review.changed };
    } catch (error) {
      throw new Error(`Apply stopped after starting. Inspect ${project.root} before retrying: ${error instanceof Error ? error.message : String(error)}`);
    }
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
  async discard(task: TaskSnapshot) {
    const review = await this.review(task);
    if (review.state) throw new Error("This code result was already handled or interrupted.");
    await git(task.project!.root, ["worktree", "remove", "--force", review.workspace]);
    await this.mark(task.id, "discarded");
    return { discarded: true };
  }
}
