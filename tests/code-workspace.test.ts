import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodeWorkspaceDecision, createCodeWorkspace } from "../electron/code-workspace.ts";
import { TaskRuntime } from "../electron/task-runtime.ts";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("coding uses a separate worktree and leaves the active checkout unchanged", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "bmo-workspace-test-"));
  context.after(() => rm(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  await mkdir(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "BMO Test");
  git(repo, "config", "user.email", "bmo@example.invalid");
  await writeFile(join(repo, "note.txt"), "original");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "initial");

  const isolated = await createCodeWorkspace(repo, "task-1", join(base, "workspaces"));
  assert.notEqual(isolated, repo);
  assert.equal(git(isolated, "rev-parse", "HEAD"), git(repo, "rev-parse", "HEAD"));
  await writeFile(join(isolated, "note.txt"), "changed");
  assert.equal(await readFile(join(repo, "note.txt"), "utf8"), "original");
  assert.equal(git(repo, "status", "--porcelain"), "");

  await writeFile(join(repo, "draft.txt"), "owner work");
  await assert.rejects(
    createCodeWorkspace(repo, "task-2", join(base, "workspaces")),
    CodeWorkspaceDecision,
  );
});

test("coding without a Git repository requires a decision", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bmo-nongit-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(createCodeWorkspace(directory, "task", join(directory, "workspaces")), CodeWorkspaceDecision);
});

test("an isolation failure pauses the Code Task for a decision", async () => {
  const runtime = new TaskRuntime(
    { async execute() { throw new CodeWorkspaceDecision("Project is dirty."); } },
    { async append() {} },
    () => {},
  );
  const task = await runtime.create("Change a file", { kind: "coding" });
  await runtime.approve(task.id);
  assert.equal(runtime.currentTask()?.status, "needs_decision");
  assert.match(runtime.currentTask()?.summary ?? "", /Project is dirty/);
});
