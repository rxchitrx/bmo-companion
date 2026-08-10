import { createHash } from "node:crypto";
import { diagnosticLog } from "./diagnostics.js";
import type { TokenUsage } from "./task-runtime.js";

export type ContextProvenance =
  | "bmo"
  | "user"
  | "task"
  | "history"
  | "memory"
  | "tool"
  | "runtime";

export interface ContextSegmentInput {
  name: string;
  source: string;
  provenance: ContextProvenance;
  value?: unknown;
  inclusionReason?: string;
  budgetChars?: number;
  truncated?: boolean;
}

export interface ContextSegmentMeasurement {
  name: string;
  source: string;
  provenance: ContextProvenance;
  measurement: "exact-visible" | "unknown-runtime" | "unavailable";
  chars?: number;
  utf8Bytes?: number;
  sha256?: string;
  itemCount?: number;
  inclusionReason?: string;
  budgetChars?: number;
  truncated?: boolean;
}

function metadata(input: ContextSegmentInput) {
  return {
    ...(input.inclusionReason ? { inclusionReason: input.inclusionReason } : {}),
    ...(input.budgetChars !== undefined ? { budgetChars: input.budgetChars } : {}),
    ...(input.truncated !== undefined ? { truncated: input.truncated } : {}),
  };
}

function serialize(value: unknown) {
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

export function measureContextSegment(
  input: ContextSegmentInput,
): ContextSegmentMeasurement {
  if (input.value === undefined) {
    return {
      name: input.name,
      source: input.source,
      provenance: input.provenance,
      measurement: "unknown-runtime",
      ...metadata(input),
    };
  }
  try {
    const serialized = serialize(input.value);
    return {
      name: input.name,
      source: input.source,
      provenance: input.provenance,
      measurement: "exact-visible",
      chars: serialized.length,
      utf8Bytes: Buffer.byteLength(serialized, "utf8"),
      sha256: createHash("sha256").update(serialized).digest("hex"),
      ...(Array.isArray(input.value) ? { itemCount: input.value.length } : {}),
      ...metadata(input),
    };
  } catch {
    return {
      name: input.name,
      source: input.source,
      provenance: input.provenance,
      measurement: "unavailable",
      ...metadata(input),
    };
  }
}

export function recordContextSnapshot(
  scope: string,
  phase: string,
  payload: unknown,
  inputs: ContextSegmentInput[],
  identifiers: Record<string, string | number | boolean | undefined> = {},
) {
  const segments = inputs.map(measureContextSegment);
  const payloadMeasurement = measureContextSegment({
    name: "serialized_payload",
    source: "bmo-transport",
    provenance: "bmo",
    value: payload,
  });
  const visibleSegments = segments.filter(
    (segment) => segment.measurement === "exact-visible",
  );
  const snapshot = {
    phase,
    ...identifiers,
    payload: payloadMeasurement,
    visibleTotals: {
      segments: visibleSegments.length,
      chars: visibleSegments.reduce((sum, segment) => sum + (segment.chars ?? 0), 0),
      utf8Bytes: visibleSegments.reduce(
        (sum, segment) => sum + (segment.utf8Bytes ?? 0),
        0,
      ),
    },
    segments,
  };
  diagnosticLog(scope, "context.snapshot", snapshot);
  return snapshot;
}

export function tokenUsageDelta(
  current: TokenUsage,
  previous?: TokenUsage,
): TokenUsage {
  if (!previous) return { ...current };
  const reset = (Object.keys(current) as Array<keyof TokenUsage>)
    .some((key) => current[key] < previous[key]);
  if (reset) return { ...current };
  return {
    inputTokens: current.inputTokens - previous.inputTokens,
    cachedInputTokens: current.cachedInputTokens - previous.cachedInputTokens,
    outputTokens: current.outputTokens - previous.outputTokens,
    reasoningOutputTokens:
      current.reasoningOutputTokens - previous.reasoningOutputTokens,
    totalTokens: current.totalTokens - previous.totalTokens,
  };
}
