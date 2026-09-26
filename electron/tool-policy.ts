import { createHash } from "node:crypto";

export type ToolRisk = "read" | "write" | "privileged";
export type ToolDecision = "allow" | "ask" | "deny";
export interface ToolRule { risk: ToolRisk; timeoutMs: number; approval: "none" | "exact-task" | "never" }

const READ = { risk: "read", timeoutMs: 60_000, approval: "none" } as const;
const WRITE = { risk: "write", timeoutMs: 120_000, approval: "exact-task" } as const;
const PRIVILEGED = { risk: "privileged", timeoutMs: 0, approval: "never" } as const;

const reads = [
  "calendar.list_calendars", "calendar.list_events", "reminders.list_reminder_lists",
  "reminders.list_reminders", "contacts.search_contacts", "notes.search_notes",
  "notes.read_note", "shortcuts.list_shortcuts", "music.now_playing",
  "files.search_files", "google.search_gmail", "google.read_gmail",
  "google.search_drive", "google.read_doc", "google.read_sheet",
  "todoist.list_tasks", "github.list_issues", "github.view_issue",
  "github.list_pull_requests", "github.view_pull_request", "github.notifications",
  "obsidian.search_notes", "obsidian.read_note", "get_task_state", "discover_services",
  "fixture.read",
] as const;
const writes = [
  "calendar.create_event", "calendar.update_event", "reminders.create_reminder",
  "reminders.update_reminder", "reminders.complete_reminder", "contacts.create_contact",
  "contacts.update_contact", "notes.create_note", "notes.append_note",
  "shortcuts.run_shortcut", "music.playpause", "music.next", "music.previous",
  "music.play_track", "google.send_email", "google.upload_drive_file",
  "google.create_doc", "google.append_sheet", "todoist.create_task",
  "todoist.complete_task", "todoist.update_task", "github.comment_issue",
  "github.create_issue", "obsidian.create_note", "obsidian.append_note",
  "control_computer", "use_service", "fixture.write",
] as const;
const privileged = [
  "codex.command_escalation", "codex.file_escalation", "codex.permission_escalation",
  "codex.mcp_elicitation", "codex.sandbox_escape", "programmatic_tool_calls",
] as const;

/** Closed registry: a newly added tool has no authority until it is reviewed here. */
export const TOOL_RISK_REGISTRY: Readonly<Record<string, ToolRule>> = Object.freeze({
  ...Object.fromEntries(reads.map((id) => [id, READ])),
  ...Object.fromEntries(writes.map((id) => [id, WRITE])),
  ...Object.fromEntries(privileged.map((id) => [id, PRIVILEGED])),
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function toolArgumentsHash(args: unknown): string {
  return createHash("sha256").update(canonical(args)).digest("hex");
}

export interface ExactToolApproval {
  taskId: string;
  actionId: string;
  argsHash: string;
  expiresAt: string;
}

export function exactToolApproval(taskId: string, actionId: string, args: unknown, expiresAt: string): ExactToolApproval {
  return { taskId, actionId, argsHash: toolArgumentsHash(args), expiresAt };
}

export interface ToolPolicyInput {
  actionId: string;
  args: unknown;
  taskId?: string;
  approvalScope?: ExactToolApproval;
  now?: Date;
  /** Advisory extensions may restrict a decision, never override the final guard. */
  extensions?: readonly ((input: ToolPolicyInput) => ToolDecision)[];
}

export function evaluateToolAction(input: ToolPolicyInput): { decision: ToolDecision; reason: string; risk: ToolRisk | "unknown"; timeoutMs: number } {
  const rule = TOOL_RISK_REGISTRY[input.actionId];
  const risk = rule?.risk ?? "unknown";
  if (!rule) return { decision: "deny", reason: "unregistered-tool", risk, timeoutMs: 0 };
  if (rule.approval === "never") return { decision: "deny", reason: "final-guard-denied", risk, timeoutMs: 0 };
  const extensionDecisions = input.extensions?.map((extension) => extension(input)) ?? [];
  if (extensionDecisions.includes("deny")) return { decision: "deny", reason: "extension-denied", risk, timeoutMs: rule.timeoutMs };
  if (rule.approval === "none") {
    return { decision: extensionDecisions.includes("ask") ? "ask" : "allow", reason: "read-only", risk, timeoutMs: rule.timeoutMs };
  }
  const scope = input.approvalScope;
  const exact = !!scope && !!input.taskId && scope.taskId === input.taskId &&
    scope.actionId === input.actionId && scope.argsHash === toolArgumentsHash(input.args) &&
    Number.isFinite(Date.parse(scope.expiresAt)) && (input.now ?? new Date()).getTime() < Date.parse(scope.expiresAt);
  if (!exact) return { decision: "ask", reason: "exact-task-approval-required", risk, timeoutMs: rule.timeoutMs };
  if (extensionDecisions.includes("ask")) return { decision: "ask", reason: "extension-asks", risk, timeoutMs: rule.timeoutMs };
  return { decision: "allow", reason: "exact-task-approved", risk, timeoutMs: rule.timeoutMs };
}
