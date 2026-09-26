import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const exec = promisify(execFile);

/** Keep the subscription runtime's basic process settings, never ambient app secrets. */
export function codeWorkerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = ["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG", "LC_ALL", "SHELL", "TERM", "CODEX_HOME", "CODEX_CLI_PATH"];
  return Object.fromEntries(allowed.flatMap((key) =>
    source[key] === undefined ? [] : [[key, source[key]]]));
}

export class CodeWorkspaceDecision extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeWorkspaceDecision";
  }
}

async function git(cwd: string, args: string[], signal?: AbortSignal) {
  return (await exec("git", args, {
    cwd, signal, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  })).stdout.trim();
}

/** Creates a fresh detached Git worktree; never copies the owner's dirty checkout. */
export async function createCodeWorkspace(
  sourceDirectory: string,
  taskId: string,
  workspacesDirectory = join(tmpdir(), "bmo-code-workspaces"),
  signal?: AbortSignal,
): Promise<string> {
  let root: string;
  try {
    root = await git(sourceDirectory, ["rev-parse", "--show-toplevel"], signal);
    await git(root, ["rev-parse", "--verify", "HEAD"], signal);
  } catch {
    throw new CodeWorkspaceDecision("Coding needs a Git repository with a commit before BMO can create an isolated workspace.");
  }
  if (await realpath(root) !== await realpath(sourceDirectory)) {
    throw new CodeWorkspaceDecision("Coding is paused because BMO's selected project folder is not the Git root. Choose the project root first.");
  }
  let dirty: string;
  try {
    dirty = await git(root, ["status", "--porcelain", "--untracked-files=all"], signal);
  } catch {
    throw new CodeWorkspaceDecision("Coding is paused because BMO could not verify that the project checkout is clean.");
  }
  if (dirty) {
    throw new CodeWorkspaceDecision("Coding is paused because the active project has uncommitted or untracked files. Decide how to handle those changes before starting an isolated Code Task.");
  }
  const location = join(workspacesDirectory, taskId);
  if (signal?.aborted) throw new CodeWorkspaceDecision("Coding workspace creation was cancelled.");
  await mkdir(workspacesDirectory, { recursive: true });
  try {
    await git(root, ["worktree", "add", "--detach", location, "HEAD"], signal);
  } catch (error) {
    throw new CodeWorkspaceDecision(`Coding needs an isolated Git worktree, but one could not be created: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (signal?.aborted) {
    await git(root, ["worktree", "remove", "--force", location]).catch(() => undefined);
    throw new CodeWorkspaceDecision("Coding workspace creation was cancelled.");
  }
  return location;
}
