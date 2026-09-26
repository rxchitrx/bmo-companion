import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiCodingTaskExecutor, piSandboxProfile } from "../electron/pi-coding-adapter.ts";
import { allowTaskAuthority, createTaskAuthorityScope } from "../electron/permission-lifecycle.ts";
import { authorizePiToolCall, scopedCodePath } from "../electron/pi-tool-scope.ts";
import toolGuard from "../electron/pi-tool-guard.ts";

function git(cwd: string, ...args: string[]) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }

function approved(goal: string, taskId: string) {
  const now = new Date();
  return {
    kind: "coding" as const, model: "gpt-6-luna", effort: "low", taskId,
    authority: allowTaskAuthority(createTaskAuthorityScope({ taskId, goal, taskKind: "coding" }), now, new Date(now.getTime() + 60_000)),
  };
}

async function fixture(context: { after: (callback: () => Promise<void>) => void }, fakeBody: string, testScript = "node --test") {
  const base = await mkdtemp(join(tmpdir(), "bmo-pi-test-"));
  context.after(() => rm(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  await mkdir(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "BMO Test");
  git(repo, "config", "user.email", "bmo@example.invalid");
  await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { test: testScript } }));
  await writeFile(join(repo, "code.js"), "export const value = 1;\n");
  await writeFile(join(repo, "code.test.js"), "const { test } = require('node:test'); const { strictEqual } = require('node:assert'); test('pass', () => strictEqual(1, 1));\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "seed");
  const fakePi = join(base, "pi-fake");
  await writeFile(fakePi, `#!/usr/bin/env node\n${fakeBody}\n`);
  await chmod(fakePi, 0o755);
  const executor = new PiCodingTaskExecutor(join(base, "workspaces"), repo, fakePi);
  return { base, repo, fakePi, executor };
}

test("Pi path guard denies escape, hidden metadata, and symlink paths", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "bmo-pi-path-"));
  context.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, "src"));
  await writeFile(join(base, "src", "file.ts"), "safe");
  await symlink("/tmp", join(base, "out"));
  assert.equal(await scopedCodePath(base, "src/file.ts"), join(await realpath(base), "src", "file.ts"));
  for (const path of ["../outside", "/etc/passwd", ".git/config", ".env", "out/secret", "src/../../outside"]) {
    await assert.rejects(scopedCodePath(base, path));
  }
  await assert.rejects(authorizePiToolCall(base, "bash", { command: "pwd" }));
  await authorizePiToolCall(base, "bmo_ls", {});
});

test("Pi extension blocks unscoped tools without an interactive approval fallback", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "bmo-pi-guard-"));
  context.after(() => rm(base, { recursive: true, force: true }));
  let handler: ((event: { toolName: string; input: Record<string, unknown> }) => Promise<{ block: true; reason: string } | undefined>) | undefined;
  const tools = new Map<string, { execute: (_id: unknown, params: Record<string, string>) => Promise<{ content: Array<{ text: string }> }> }>();
  const previous = process.cwd();
  process.chdir(base);
  try { toolGuard({ on: (_name, callback) => { handler = callback; }, registerTool: (definition) => { tools.set(definition.name, definition); } }); }
  finally { process.chdir(previous); }
  assert.equal((await handler!({ toolName: "bmo_read", input: { path: "/etc/passwd" } }))?.block, true);
  assert.equal((await handler!({ toolName: "bash", input: { command: "echo bad" } }))?.block, true);
  assert.equal(await handler!({ toolName: "bmo_read", input: { path: "ok.txt" } }), undefined);
  assert.deepEqual([...tools.keys()], ["bmo_ls", "bmo_read", "bmo_edit", "bmo_write"]);
  await assert.rejects(tools.get("bmo_read")!.execute("1", { path: "/etc/passwd" }));
  await tools.get("bmo_write")!.execute("2", { path: "ok.txt", content: "safe" });
  assert.equal((await tools.get("bmo_read")!.execute("3", { path: "ok.txt" })).content[0]?.text, "safe");
});

test("macOS sandbox profile permits only worktree and scratch writes", async (context) => {
  if (process.platform !== "darwin") return;
  const base = await mkdtemp(join(tmpdir(), "bmo-pi-sandbox-"));
  context.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "workspace");
  const scratch = join(base, "scratch");
  await mkdir(workspace); await mkdir(scratch);
  const profile = join(scratch, "profile.sb");
  await writeFile(profile, piSandboxProfile(await realpath(workspace), await realpath(scratch), join(base, "auth.json"), false));
  const allowed = execFileSync("sandbox-exec", ["-f", profile, "/bin/sh", "-c", "echo ok > workspace/inside", "sh"], { cwd: base });
  assert.equal(allowed.length, 0);
  assert.equal(await readFile(join(workspace, "inside"), "utf8"), "ok\n");
  assert.throws(() => execFileSync("sandbox-exec", ["-f", profile, "/bin/sh", "-c", "echo bad > outside", "sh"], { cwd: base, stdio: "ignore" }));
  await assert.rejects(lstat(join(base, "outside")));
});

test("Pi adapter verifies changed code with original project tests and leaves source untouched", async (context) => {
  if (process.platform !== "darwin") return;
  const fake = `const fs = require('node:fs'); fs.writeFileSync('code.js', 'export const value = 2;\\n');
    console.log(JSON.stringify({type:'turn_start'}));
    console.log(JSON.stringify({type:'tool_execution_start',toolCallId:'1',toolName:'bmo_write',args:{path:'code.js'}}));
    console.log(JSON.stringify({type:'tool_execution_end',toolCallId:'1',toolName:'bmo_write',isError:false}));
    console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'VERIFIED OUTCOME: Updated code.'}],usage:{input:10,cacheRead:5,cacheWrite:1,output:2}}}));
    console.log(JSON.stringify({type:'agent_end'}));`;
  const { repo, executor } = await fixture(context, fake);
  const progress: string[] = [];
  const result = await executor.execute("Update code", new AbortController().signal, (value) => progress.push(value), undefined, undefined,
    approved("Update code", "verified-task"));
  assert.equal(result.verified, true, result.summary);
  assert.equal(result.usage?.inputTokens, 16);
  assert.equal(result.usage?.totalTokens, 18);
  assert.equal(await readFile(join(repo, "code.js"), "utf8"), "export const value = 1;\n");
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.ok(progress.some((value) => value.includes("original tests")));
});

test("Pi adapter rejects changed tests, incomplete protocol, and cancelled runs", async (context) => {
  if (process.platform !== "darwin") return;
  const testChanger = `const fs = require('node:fs'); fs.writeFileSync('code.test.js', 'test'); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'VERIFIED OUTCOME: done'}]}})); console.log(JSON.stringify({type:'agent_end'}));`;
  const one = await fixture(context, testChanger);
  const result = await one.executor.execute("Cheat test", new AbortController().signal, () => {}, undefined, undefined,
    approved("Cheat test", "changed-test"));
  assert.equal(result.verified, false);
  assert.match(result.summary, /require review/);

  const incomplete = await fixture(context, `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'VERIFIED OUTCOME: done'}]}}));`);
  const missing = await incomplete.executor.execute("Incomplete", new AbortController().signal, () => {}, undefined, undefined,
    approved("Incomplete", "incomplete"));
  assert.equal(missing.verified, false);

  const slow = await fixture(context, `setTimeout(() => {}, 30000);`);
  const controller = new AbortController();
  const pending = slow.executor.execute("Cancel", controller.signal, () => {}, undefined, undefined,
    approved("Cancel", "cancelled"));
  setTimeout(() => controller.abort(), 250);
  const cancelled = await pending;
  assert.equal(cancelled.verified, false);
  assert.match(cancelled.summary, /revoked/);
});

test("Pi adapter fails closed on unapproved tools, crashes after writes, and tool timeouts", async (context) => {
  if (process.platform !== "darwin") return;
  const unknown = await fixture(context, `console.log(JSON.stringify({type:'tool_execution_start',toolCallId:'1',toolName:'bash',args:{command:'echo bad'}})); setTimeout(() => {}, 10000);`);
  const denied = await unknown.executor.execute("Unsafe", new AbortController().signal, () => {}, undefined, undefined,
    approved("Unsafe", "unknown-tool"));
  assert.equal(denied.verified, false);
  assert.equal(denied.reconciliationRequired, true);
  assert.match(denied.summary, /unapproved tool/);

  const crash = await fixture(context, `require('node:fs').writeFileSync('code.js', 'changed'); process.exit(1);`);
  const crashed = await crash.executor.execute("Crash", new AbortController().signal, () => {}, undefined, undefined,
    approved("Crash", "crash-after-write"));
  assert.equal(crashed.verified, false);
  assert.equal(crashed.reconciliationRequired, true);

  const slow = await fixture(context, `console.log(JSON.stringify({type:'tool_execution_start',toolCallId:'1',toolName:'bmo_read',args:{path:'code.js'}})); setTimeout(() => {}, 10000);`);
  const fastDeadline = new PiCodingTaskExecutor(join(slow.base, "deadline-workspaces"), slow.repo, slow.fakePi, { toolMs: 100 });
  const expired = await fastDeadline.execute("Timeout", new AbortController().signal, () => {}, undefined, undefined,
    approved("Timeout", "tool-timeout"));
  assert.equal(expired.verified, false);
  assert.equal(expired.reconciliationRequired, true);
  assert.match(expired.summary, /deadline/);
});

test("Pi adapter refuses to start without matching approved Task authority", async (context) => {
  const { executor } = await fixture(context, `throw new Error('This process must never start');`);
  await assert.rejects(
    executor.execute("Unauthorized", new AbortController().signal, () => {}, undefined, undefined,
      { kind: "coding", model: "gpt-6-luna", effort: "low", taskId: "unapproved" }),
    /Task authority ask/,
  );
  await assert.rejects(
    executor.execute("Different goal", new AbortController().signal, () => {}, undefined, undefined,
      approved("Approved goal", "mismatch")),
    /scope-mismatch/,
  );
});

test("Pi adapter rejects tests that mutate the candidate worktree after the agent settles", async (context) => {
  if (process.platform !== "darwin") return;
  const fake = `require('node:fs').writeFileSync('code.js', 'agent version'); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'VERIFIED OUTCOME: done'}]}})); console.log(JSON.stringify({type:'agent_end'}));`;
  const { executor } = await fixture(context, fake, "node -e \"require('fs').writeFileSync('code.js', 'test version')\"");
  const result = await executor.execute("Update and verify", new AbortController().signal, () => {}, undefined, undefined,
    approved("Update and verify", "mutating-test"));
  assert.equal(result.verified, false);
  assert.equal(result.reconciliationRequired, true);
  assert.match(result.summary, /changed the worktree/);
});
