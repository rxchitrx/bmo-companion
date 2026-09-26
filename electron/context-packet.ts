import type { ContextSegmentInput } from "./context-telemetry.js";
import type { TaskKind } from "./task-runtime.js";

export const TASK_GOAL_MAX_CHARS = 20_000;
export const TASK_HISTORY_MAX_CHARS = 2_000;
export const TASK_CONTEXT_MAX_CHARS =
  TASK_GOAL_MAX_CHARS + TASK_HISTORY_MAX_CHARS;

export type ContextPacketProvenance = "user" | "task_history";

export interface ContextPacketManifestEntry {
  id: "task_goal" | "retry_outcome";
  provenance: ContextPacketProvenance;
  source: string;
  inclusionReason: string;
  originalChars: number;
  includedChars: number;
  truncated: boolean;
}

export interface ContextPacketCapabilityReference {
  id: "codex.general" | "bmo.code_workspace" | "codex.computer_use";
  reason: string;
}

export interface TaskContextPacket {
  schemaVersion: "1";
  purpose: {
    type: "task_execution";
    taskKind: TaskKind;
    objective: string;
  };
  relevantContext: Array<{
    id: "retry_outcome";
    kind: "bounded_history_summary";
    content: string;
    trust: "untrusted_data";
  }>;
  capabilityReferences: ContextPacketCapabilityReference[];
  budget: {
    unit: "characters";
    maxContentChars: number;
    usedContentChars: number;
    remainingContentChars: number;
    maxHistoryChars: number;
  };
  historyPolicy: {
    mode: "existing_summary_only";
    rawHistoryIncluded: false;
    truncation: "head_tail_unicode_safe";
  };
  manifest: ContextPacketManifestEntry[];
}

function safeStart(value: string, maxChars: number) {
  let end = Math.min(value.length, Math.max(0, maxChars));
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1] ?? "")) end -= 1;
  return value.slice(0, end);
}

function safeEnd(value: string, maxChars: number) {
  let start = Math.max(0, value.length - Math.max(0, maxChars));
  if (start < value.length && /[\uDC00-\uDFFF]/.test(value[start] ?? "")) start += 1;
  return value.slice(start);
}

export function boundHistorySummary(
  value: string,
  maxChars = TASK_HISTORY_MAX_CHARS,
) {
  const normalized = value.replaceAll("\0", "").trim();
  if (normalized.length <= maxChars) {
    return { content: normalized, originalChars: normalized.length, truncated: false };
  }
  const marker = "\n[... earlier Task summary truncated ...]\n";
  if (maxChars <= marker.length) {
    return {
      content: safeStart(normalized, maxChars),
      originalChars: normalized.length,
      truncated: true,
    };
  }
  const available = Math.max(0, maxChars - marker.length);
  const headChars = Math.ceil(available * 0.7);
  const tailChars = available - headChars;
  const content = [
    safeStart(normalized, headChars),
    marker,
    safeEnd(normalized, tailChars),
  ].join("");
  return {
    content,
    originalChars: normalized.length,
    truncated: true,
  };
}

function capabilityReferences(
  kind: TaskKind,
): ContextPacketCapabilityReference[] {
  if (kind === "connector") return [];
  if (kind === "coding") {
    return [{
      id: "bmo.code_workspace",
      reason: "The Task explicitly requires work in BMO's isolated code workspace.",
    }];
  }
  if (kind === "computer" || kind === "browser") {
    return [{
      id: "codex.computer_use",
      reason: "The Task explicitly requires observing and controlling a visible UI.",
    }];
  }
  return [{
    id: "codex.general",
    reason: "The Task requires only the baseline scoped Codex worker.",
  }];
}

export function createTaskContextPacket(input: {
  goal: string;
  kind?: TaskKind;
  retryOf?: string;
  priorOutcome?: string;
}): TaskContextPacket {
  const objective = input.goal.trim();
  if (!objective) throw new Error("Task goal cannot be empty.");
  if (objective.length > TASK_GOAL_MAX_CHARS) {
    throw new Error(`Task goal exceeds the ${TASK_GOAL_MAX_CHARS}-character Context Packet limit.`);
  }
  const taskKind = input.kind ?? "general";
  const manifest: ContextPacketManifestEntry[] = [{
    id: "task_goal",
    provenance: "user",
    source: "TaskSnapshot.goal",
    inclusionReason: "The worker needs the approved Task objective.",
    originalChars: objective.length,
    includedChars: objective.length,
    truncated: false,
  }];
  const relevantContext: TaskContextPacket["relevantContext"] = [];
  if (input.retryOf && input.priorOutcome?.trim()) {
    const bounded = boundHistorySummary(input.priorOutcome);
    relevantContext.push({
      id: "retry_outcome",
      kind: "bounded_history_summary",
      content: bounded.content,
      trust: "untrusted_data",
    });
    manifest.push({
      id: "retry_outcome",
      provenance: "task_history",
      source: "TaskSnapshot.priorOutcome",
      inclusionReason: `The owner explicitly retried Task ${input.retryOf}; its bounded outcome helps prevent duplicate actions.`,
      originalChars: bounded.originalChars,
      includedChars: bounded.content.length,
      truncated: bounded.truncated,
    });
  }
  const usedContentChars = objective.length + relevantContext.reduce(
    (total, item) => total + item.content.length,
    0,
  );
  return {
    schemaVersion: "1",
    purpose: { type: "task_execution", taskKind, objective },
    relevantContext,
    capabilityReferences: capabilityReferences(taskKind),
    budget: {
      unit: "characters",
      maxContentChars: TASK_CONTEXT_MAX_CHARS,
      usedContentChars,
      remainingContentChars: TASK_CONTEXT_MAX_CHARS - usedContentChars,
      maxHistoryChars: TASK_HISTORY_MAX_CHARS,
    },
    historyPolicy: {
      mode: "existing_summary_only",
      rawHistoryIncluded: false,
      truncation: "head_tail_unicode_safe",
    },
    manifest,
  };
}

export function renderTaskContextPacket(packet: TaskContextPacket) {
  return `[BMO TASK CONTEXT PACKET v${packet.schemaVersion}]\n${JSON.stringify(packet, null, 2)}`;
}

export function contextPacketTelemetrySegments(
  packet: TaskContextPacket,
): ContextSegmentInput[] {
  return packet.manifest.map((entry) => ({
    name: entry.id,
    source: entry.source,
    provenance: entry.provenance === "user" ? "user" : "history",
    value: entry.id === "task_goal"
      ? packet.purpose.objective
      : packet.relevantContext.find((item) => item.id === entry.id)?.content,
    inclusionReason: entry.inclusionReason,
    budgetChars: entry.id === "task_goal"
      ? TASK_GOAL_MAX_CHARS
      : TASK_HISTORY_MAX_CHARS,
    truncated: entry.truncated,
  }));
}
