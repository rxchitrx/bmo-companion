import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const HIDDEN_ALLOWED = new Set([".gitignore", ".editorconfig"]);

export async function scopedCodePath(root: string, input: unknown): Promise<string> {
  if (typeof input !== "string" || !input.trim() || input.includes("\0")) {
    throw new Error("A nonempty file path is required.");
  }
  const canonicalRoot = await realpath(root);
  const candidate = resolve(canonicalRoot, input);
  const rel = relative(canonicalRoot, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("The path is outside the approved code workspace.");
  }
  if (rel.split(sep).some((part) => part.startsWith(".") && !HIDDEN_ALLOWED.has(part))) {
    throw new Error("Hidden configuration and Git metadata are outside coding tool scope.");
  }
  let cursor = canonicalRoot;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error("Symlink paths are outside coding tool scope.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return candidate;
}

/** All Pi capabilities are limited to the approved isolated Code Task. */
export const PI_CODE_TOOL_POLICY = Object.freeze({
  bmo_ls: { risk: "read", approval: "approved-code-task", timeoutMs: 120_000 },
  bmo_read: { risk: "read", approval: "approved-code-task", timeoutMs: 120_000 },
  bmo_edit: { risk: "write", approval: "approved-code-task", timeoutMs: 120_000 },
  bmo_write: { risk: "write", approval: "approved-code-task", timeoutMs: 120_000 },
} as const);
export const PI_CODE_TOOLS = new Set(Object.keys(PI_CODE_TOOL_POLICY));

export async function authorizePiToolCall(root: string, toolName: string, input: Record<string, unknown>): Promise<void> {
  if (!PI_CODE_TOOLS.has(toolName)) throw new Error(`Tool ${toolName} is outside the approved coding scope.`);
  await scopedCodePath(root, toolName === "bmo_ls" && input.path === undefined ? "." : input.path);
}
