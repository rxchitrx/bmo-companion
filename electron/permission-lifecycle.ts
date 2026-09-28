import { createHash } from "node:crypto";

export const TASK_AUTHORITY_VERSION = 1 as const;

export type PermissionDecision = "allow" | "ask" | "deny";
export type AuthorityState = "pending" | "active" | "paused" | "expired" | "revoked";
export type AuthorityWorkerId = "codex-task" | "code-task" | "connector-task";

export interface TaskAuthorityScope {
  taskId: string;
  taskKind: "general" | "coding" | "computer" | "browser" | "connector";
  workerId: AuthorityWorkerId;
  objectiveSha256: string;
  capabilityIds: string[];
  projectSha256?: string;
}

export interface ScopedTaskAuthority {
  version: typeof TASK_AUTHORITY_VERSION;
  decision: PermissionDecision;
  state: AuthorityState;
  scope: TaskAuthorityScope;
  decidedAt: string;
  expiresAt?: string;
  reason: string;
}

export interface AuthorityPolicyResult {
  decision: PermissionDecision;
  reason:
    | "authority-allowed"
    | "owner-approval-required"
    | "authority-paused"
    | "authority-expired"
    | "authority-revoked"
    | "scope-mismatch";
}

export class TaskAuthorityError extends Error {
  constructor(readonly policy: AuthorityPolicyResult) {
    super(`Task authority ${policy.decision}: ${policy.reason}.`);
    this.name = "TaskAuthorityError";
  }
}

function objectiveSha256(goal: string): string {
  return createHash("sha256").update(goal.trim()).digest("hex");
}

export function capabilityIdsForTask(
  kind: TaskAuthorityScope["taskKind"],
  connectorCall?: { service: string; action: string },
): string[] {
  if (kind === "connector") {
    return connectorCall ? [`${connectorCall.service}.${connectorCall.action}`] : [];
  }
  if (kind === "coding") return ["bmo.code_workspace"];
  if (kind === "computer" || kind === "browser") return ["codex.computer_use"];
  return ["codex.general"];
}

export function createTaskAuthorityScope(input: {
  taskId: string;
  goal: string;
  taskKind?: TaskAuthorityScope["taskKind"];
  workerId?: AuthorityWorkerId;
  capabilityIds?: readonly string[];
  connectorCall?: { service: string; action: string };
  project?: { id: string; root: string; baseCommit: string; verification: string };
}): TaskAuthorityScope {
  const taskKind = input.taskKind ?? "general";
  return {
    taskId: input.taskId,
    taskKind,
    workerId: input.workerId ?? (taskKind === "connector" ? "connector-task" : taskKind === "coding" ? "code-task" : "codex-task"),
    objectiveSha256: objectiveSha256(input.goal),
    ...(input.project ? { projectSha256: createHash("sha256").update(JSON.stringify([
      input.project.id, input.project.root, input.project.baseCommit, input.project.verification,
    ])).digest("hex") } : {}),
    capabilityIds: [...(
      input.capabilityIds ?? capabilityIdsForTask(taskKind, input.connectorCall)
    )].sort(),
  };
}

export function askForTaskAuthority(
  scope: TaskAuthorityScope,
  now: Date,
  reason = "owner-approval-required",
): ScopedTaskAuthority {
  return {
    version: TASK_AUTHORITY_VERSION,
    decision: "ask",
    state: "pending",
    scope,
    decidedAt: now.toISOString(),
    reason,
  };
}

export function allowTaskAuthority(
  scope: TaskAuthorityScope,
  now: Date,
  expiresAt: Date,
  reason = "owner-approved",
): ScopedTaskAuthority {
  return {
    version: TASK_AUTHORITY_VERSION,
    decision: "allow",
    state: "active",
    scope,
    decidedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    reason,
  };
}

export function pauseTaskAuthority(
  authority: ScopedTaskAuthority,
  now: Date,
  reason: string,
): ScopedTaskAuthority {
  return {
    ...authority,
    state: "paused",
    decidedAt: now.toISOString(),
    reason,
  };
}

export function requireTaskAuthorityDecision(
  authority: ScopedTaskAuthority,
  now: Date,
  reason: string,
  state: Extract<AuthorityState, "pending" | "paused" | "expired"> = "paused",
): ScopedTaskAuthority {
  return {
    ...authority,
    decision: "ask",
    state,
    decidedAt: now.toISOString(),
    reason,
  };
}

export function denyTaskAuthority(
  authority: ScopedTaskAuthority,
  now: Date,
  reason: string,
): ScopedTaskAuthority {
  return {
    ...authority,
    decision: "deny",
    state: "revoked",
    decidedAt: now.toISOString(),
    reason,
  };
}

export function revalidateTaskAuthority(
  authority: ScopedTaskAuthority,
  now: Date,
): ScopedTaskAuthority {
  return {
    ...authority,
    decision: "allow",
    state: "active",
    decidedAt: now.toISOString(),
    reason: "scope-revalidated",
  };
}

function sameScope(actual: TaskAuthorityScope, expected: TaskAuthorityScope): boolean {
  return (
    actual.taskId === expected.taskId &&
    actual.taskKind === expected.taskKind &&
    actual.workerId === expected.workerId &&
    actual.objectiveSha256 === expected.objectiveSha256 &&
    actual.projectSha256 === expected.projectSha256 &&
    actual.capabilityIds.length === expected.capabilityIds.length &&
    actual.capabilityIds.every((id, index) => id === expected.capabilityIds[index])
  );
}

export function evaluateTaskAuthority(
  authority: ScopedTaskAuthority | undefined,
  expectedScope: TaskAuthorityScope,
  now: Date,
  options: { allowPaused?: boolean } = {},
): AuthorityPolicyResult {
  if (!authority) return { decision: "ask", reason: "owner-approval-required" };
  if (!sameScope(authority.scope, expectedScope)) {
    return { decision: "deny", reason: "scope-mismatch" };
  }
  if (authority.decision === "deny" || authority.state === "revoked") {
    return { decision: "deny", reason: "authority-revoked" };
  }
  if (authority.decision !== "allow") {
    return { decision: "ask", reason: "owner-approval-required" };
  }
  if (authority.state === "expired" || !authority.expiresAt || now.getTime() >= Date.parse(authority.expiresAt)) {
    return { decision: "ask", reason: "authority-expired" };
  }
  if (authority.state !== "active" && !(options.allowPaused && authority.state === "paused")) {
    return { decision: "ask", reason: "authority-paused" };
  }
  return { decision: "allow", reason: "authority-allowed" };
}
