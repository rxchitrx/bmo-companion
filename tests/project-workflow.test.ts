import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ProjectRegistry } from "../electron/project-registry.ts";
import { CodeReviewService } from "../electron/code-review.ts";
import { workspaceState, verificationCommand } from "../electron/pi-coding-adapter.ts";
import { createCodeWorkspace } from "../electron/code-workspace.ts";
import { allowTaskAuthority, createTaskAuthorityScope, evaluateTaskAuthority } from "../electron/permission-lifecycle.ts";
import type { TaskSnapshot } from "../electron/task-runtime.ts";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await exec("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "BMO Test", GIT_AUTHOR_EMAIL: "bmo@example.invalid", GIT_COMMITTER_NAME: "BMO Test", GIT_COMMITTER_EMAIL: "bmo@example.invalid" } })).stdout.trim();
}
async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), "bmo-project-workflow-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "project");
  await exec("mkdir", [root]);
  await git(root, "init", "-q");
  await writeFile(join(root, "app.js"), "export const value = 1;\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "base");
  return { base, root, registry: new ProjectRegistry(join(base, "projects.json")) };
}

test("saved projects resolve spoken aliases and freeze the selected Git commit", async (t) => {
  const { root, registry } = await fixture(t);
  const saved = await registry.add(root, "BMO", "npm-test", ["my companion"]);
  assert.equal((await registry.select(" MY   COMPANION ")).id, saved.id);
  const snapshot = await registry.snapshot();
  assert.equal(snapshot.baseCommit, await git(root, "rev-parse", "HEAD"));
  await assert.rejects(registry.add(root, "Duplicate", "npm-test"), /already saved/);
  await assert.rejects(registry.selected("unknown"), /not found/);
});

test("code review applies a verified isolated diff once and protects changed source", async (t) => {
  const { base, root, registry } = await fixture(t);
  const saved = await registry.add(root, "BMO", "npm-test");
  const project = await registry.snapshot(saved.id);
  const taskId = "11111111-1111-4111-8111-111111111111";
  const workspaces = join(base, "workspaces");
  await exec("mkdir", [workspaces]);
  const workspace = join(workspaces, taskId);
  await git(root, "worktree", "add", "--detach", workspace, "HEAD");
  await writeFile(join(workspace, "app.js"), "export const value = 2;\n");
  const state = await workspaceState(workspace);
  const task: TaskSnapshot = { id: taskId, goal: "Change value", kind: "coding", status: "completed", state: "speaking", progress: [], project, codeReview: state };
  const service = new CodeReviewService(workspaces, join(base, "review.json"));
  const review = await service.review(task);
  assert.match(review.diff, /value = 2/);
  assert.equal(await readFile(join(root, "app.js"), "utf8"), "export const value = 1;\n");
  await writeFile(join(root, "owner.txt"), "owner work\n");
  await assert.rejects(service.apply(task), /checkout has changes/);
  await rm(join(root, "owner.txt"));
  await service.apply(task);
  assert.equal(await readFile(join(root, "app.js"), "utf8"), "export const value = 2;\n");
  await assert.rejects(service.apply(task), /already applied/);
});

test("discard removes only the isolated worktree and leaves the project intact", async (t) => {
  const { base, root, registry } = await fixture(t);
  const saved = await registry.add(root, "BMO", "npm-test");
  const project = await registry.snapshot(saved.id);
  const taskId = "22222222-2222-4222-8222-222222222222";
  const workspaces = join(base, "workspaces");
  await exec("mkdir", [workspaces]);
  const workspace = join(workspaces, taskId);
  await git(root, "worktree", "add", "--detach", workspace, "HEAD");
  await writeFile(join(workspace, "app.js"), "export const value = 3;\n");
  const task: TaskSnapshot = { id: taskId, goal: "Change value", kind: "coding", status: "completed", state: "speaking", progress: [], project, codeReview: await workspaceState(workspace) };
  const service = new CodeReviewService(workspaces, join(base, "review.json"));
  await service.discard(task);
  assert.equal(await readFile(join(root, "app.js"), "utf8"), "export const value = 1;\n");
  assert.equal((await service.review(task)).state, "discarded");
});

test("verification presets are closed and require an existing npm test script", () => {
  assert.equal(verificationCommand("npm-test", {}), undefined);
  assert.equal(verificationCommand("npm-test", { scripts: { test: "node --test" } })?.label, "npm test");
  assert.deepEqual(verificationCommand("python-unittest", {})?.args, ["python3", "-m", "unittest", "discover"]);
  assert.deepEqual(verificationCommand("pytest", {})?.args, ["python3", "-m", "pytest", "-q", "-p", "no:cacheprovider"]);
});

test("approval is bound to the chosen project and starting commit", async (t) => {
  const { base, root, registry } = await fixture(t);
  const saved = await registry.add(root, "BMO", "npm-test");
  const project = await registry.snapshot(saved.id);
  const scope = createTaskAuthorityScope({ taskId: "task-1", goal: "Fix bug", taskKind: "coding", project });
  const authority = allowTaskAuthority(scope, new Date(), new Date(Date.now() + 60_000));
  assert.equal(evaluateTaskAuthority(authority, scope, new Date()).decision, "allow");
  assert.equal(evaluateTaskAuthority(authority, createTaskAuthorityScope({ taskId: "task-1", goal: "Fix bug", taskKind: "coding", project: { ...project, root: join(base, "other") } }), new Date()).reason, "scope-mismatch");
  assert.equal(evaluateTaskAuthority(authority, createTaskAuthorityScope({ taskId: "task-1", goal: "Fix bug", taskKind: "coding", project: { ...project, baseCommit: "different" } }), new Date()).reason, "scope-mismatch");
  await writeFile(join(root, "app.js"), "export const value = 4;\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "changed");
  await assert.rejects(createCodeWorkspace(root, "33333333-3333-4333-8333-333333333333", join(base, "workspaces"), undefined, project.baseCommit), /changed since approval/);
});

test("review detects worktree edits after verification", async (t) => {
  const { base, root, registry } = await fixture(t);
  const project = await registry.snapshot((await registry.add(root, "BMO", "npm-test")).id);
  const taskId = "44444444-4444-4444-8444-444444444444";
  const workspaces = join(base, "workspaces");
  await exec("mkdir", [workspaces]);
  const workspace = join(workspaces, taskId);
  await git(root, "worktree", "add", "--detach", workspace, "HEAD");
  await writeFile(join(workspace, "app.js"), "export const value = 2;\n");
  const task: TaskSnapshot = { id: taskId, goal: "Change value", kind: "coding", status: "completed", state: "speaking", progress: [], project, codeReview: await workspaceState(workspace) };
  await writeFile(join(workspace, "app.js"), "export const value = 5;\n");
  const service = new CodeReviewService(workspaces, join(base, "review.json"));
  await assert.rejects(service.review(task), /changed since verification/);
  await assert.rejects(service.apply(task), /changed since verification/);
  assert.equal(await readFile(join(root, "app.js"), "utf8"), "export const value = 1;\n");
});

test("code results survive restart and keep their review decision", async (t) => {
  const { base, root, registry } = await fixture(t);
  const project = await registry.snapshot((await registry.add(root, "BMO", "npm-test")).id);
  const taskId = "55555555-5555-4555-8555-555555555555";
  const workspaces = join(base, "workspaces");
  await exec("mkdir", [workspaces]);
  const workspace = join(workspaces, taskId);
  await git(root, "worktree", "add", "--detach", workspace, "HEAD");
  await writeFile(join(workspace, "app.js"), "export const value = 6;\n");
  const task: TaskSnapshot = { id: taskId, goal: "Change value", kind: "coding", status: "completed", state: "speaking", progress: [], project, codeReview: await workspaceState(workspace) };
  const journal = join(base, "review.json");
  const first = new CodeReviewService(workspaces, journal);
  await first.remember(task);
  const restarted = new CodeReviewService(workspaces, journal);
  const restored = await restarted.task(taskId);
  assert.equal(restored?.project?.id, project.id);
  assert.match((await restarted.review(restored!)).diff, /value = 6/);
  await restarted.discard(restored!);
  assert.equal((await new CodeReviewService(workspaces, journal).list())[0].state, "discarded");
  assert.equal(await readFile(join(root, "app.js"), "utf8"), "export const value = 1;\n");
});
