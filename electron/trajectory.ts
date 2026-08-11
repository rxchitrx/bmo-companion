import { createHash } from "node:crypto";
import type {
  ContextProvenance,
  ContextSegmentMeasurement,
} from "./context-telemetry.js";
import { tokenUsageDelta } from "./context-telemetry.js";
import type {
  ExecutionCapabilityManifest,
  KernelLifecycleEvent,
} from "./execution-kernel.js";
import type {
  ExecutionGuardrailOutcome,
  TaskKind,
  TokenUsage,
} from "./task-runtime.js";
import type {
  VerificationDecision,
  VerificationEvidence,
} from "./outcome-verifier.js";

export const TRAJECTORY_SCHEMA_VERSION = "1.0" as const;
export const TRAJECTORY_RECORD_TYPE = "bmo.trajectory" as const;

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const EVENT_TEXT_KEYS = new Set(["message", "detail", "summary", "statement", "text"]);
const SAFE_METADATA_KEYS = new Set([
  "action",
  "artifactCount",
  "contextItemCount",
  "decision",
  "errorName",
  "guardrailReason",
  "kind",
  "manifestVersion",
  "outcomeStatus",
  "packetVersion",
  "reason",
  "reconciliationRequired",
  "selectedCapabilityCount",
  "status",
  "taskKind",
  "usedContentChars",
  "verifiedClaim",
  "workerId",
]);
const TASK_KINDS = new Set(["general", "coding", "computer", "browser", "connector"]);
const CONTEXT_PROVENANCE = new Set(["bmo", "user", "task", "history", "memory", "tool", "runtime"]);
const CONTEXT_MEASUREMENTS = new Set(["exact-visible", "unknown-runtime", "unavailable"]);
const CAPABILITY_SOURCES = new Set(["context-packet", "connector-selector"]);
const EVIDENCE_KINDS = new Set(["worker-contract", "protocol-settlement", "state-observation", "tool-result", "artifact", "reconciliation"]);
const EXECUTION_EVENT = /(^|[._-])(tool|connector|computer)([._-].*)?(execut|call|use|started)/i;

export type TrajectoryTaskKind = TaskKind;
export type TrajectoryEventMetadata = Record<
  string,
  string | number | boolean | TrajectoryTextDigest
>;

export interface TrajectoryTextDigest {
  chars: number;
  utf8Bytes: number;
  sha256: string;
}

export interface TrajectoryContextSegment {
  name: string;
  source: string;
  provenance: ContextProvenance;
  measurement: ContextSegmentMeasurement["measurement"];
  chars?: number;
  utf8Bytes?: number;
  sha256?: string;
  itemCount?: number;
  budgetChars?: number;
  truncated?: boolean;
}

export interface TrajectoryTaskMetadata {
  taskId: TrajectoryTextDigest;
  goal: TrajectoryTextDigest;
  kind: TrajectoryTaskKind;
  model?: string;
  effort?: string;
}

export interface TrajectoryContextMetadata {
  packetVersion?: string;
  itemCount?: number;
  usedContentChars?: number;
  segments: TrajectoryContextSegment[];
}

export interface TrajectoryLifecycleEvent {
  sequence: number;
  type: string;
  elapsedMs?: number;
  metadata: TrajectoryEventMetadata;
}

export interface TrajectoryCapability {
  id: string;
  source: "context-packet" | "connector-selector";
  reason: TrajectoryTextDigest;
}

export interface TrajectoryUsageDelta extends TokenUsage {
  sequence: number;
}

export interface TrajectoryGuardrailOutcome {
  sequence?: number;
  version: number;
  action: ExecutionGuardrailOutcome["action"];
  reason: ExecutionGuardrailOutcome["reason"];
  observed: number;
  limit: number;
  summaryDigest: TrajectoryTextDigest;
}

export interface TrajectoryVerificationEvidence {
  id: string;
  kind: VerificationEvidence["kind"];
  source: string;
  polarity: VerificationEvidence["polarity"];
  strength: VerificationEvidence["strength"];
  statementDigest: TrajectoryTextDigest;
}

export interface TrajectoryVerificationDecision {
  version: number;
  status: VerificationDecision["status"];
  reasonCodes: string[];
  evidence: {
    considered: number;
    supporting: number;
    contradictory: number;
    directSupporting: number;
  };
}

export type UserCorrectionKind =
  | "approval"
  | "scope-change"
  | "stop"
  | "cancel"
  | "resume"
  | "retry"
  | "other";

export interface TrajectoryUserCorrection {
  sequence: number;
  kind: UserCorrectionKind;
  correctionDigest: TrajectoryTextDigest;
}

export interface TrajectoryPrivacyContract {
  rawContent: false;
  rawToolData: false;
  personalData: false;
  replayExecutesTools: false;
  replayUsesLiveServices: false;
  replayUsesComputerUse: false;
}

export interface TrajectoryRecord {
  schemaVersion: typeof TRAJECTORY_SCHEMA_VERSION;
  recordType: typeof TRAJECTORY_RECORD_TYPE;
  trajectoryId: string;
  privacy: TrajectoryPrivacyContract;
  task: TrajectoryTaskMetadata;
  context: TrajectoryContextMetadata;
  events: TrajectoryLifecycleEvent[];
  selectedCapabilities: TrajectoryCapability[];
  usageDeltas: TrajectoryUsageDelta[];
  guardrailOutcomes: TrajectoryGuardrailOutcome[];
  verificationDecision?: TrajectoryVerificationDecision;
  verificationEvidence: TrajectoryVerificationEvidence[];
  userCorrections: TrajectoryUserCorrection[];
}

export interface TrajectoryRecorderInput {
  taskId: string;
  goal: string;
  kind?: TaskKind;
  model?: string;
  effort?: string;
  trajectoryId?: string;
}

export interface TrajectoryContextMetadataInput {
  packetVersion?: string;
  itemCount?: number;
  usedContentChars?: number;
  segments: readonly ContextSegmentMeasurement[];
}

export interface TrajectoryLifecycleEventInput {
  sequence: number;
  type: string;
  elapsedMs?: number;
  metadata?: Record<string, unknown>;
}

function digest(value: string): TrajectoryTextDigest {
  return {
    chars: value.length,
    utf8Bytes: Buffer.byteLength(value, "utf8"),
    sha256: createHash("sha256").update(value, "utf8").digest("hex"),
  };
}

function digestFromExisting(value: { chars: number; sha256: string }): TrajectoryTextDigest {
  return {
    chars: value.chars,
    utf8Bytes: value.chars,
    sha256: value.sha256,
  };
}

function identifier(value: string, name: string): string {
  const normalized = value.trim();
  if (!SAFE_IDENTIFIER.test(normalized)) {
    throw new Error(`${name} must be a bounded identifier.`);
  }
  return normalized;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function cloneDigest(value: TrajectoryTextDigest): TrajectoryTextDigest {
  return { ...value };
}

function cloneRecord(record: TrajectoryRecord): TrajectoryRecord {
  return structuredClone(record);
}

function sanitizeMetadataValue(key: string, value: unknown): string | number | boolean | TrajectoryTextDigest {
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (SAFE_METADATA_KEYS.has(key) && SAFE_IDENTIFIER.test(value.trim())) {
      return value.trim();
    }
    return digest(value);
  }
  if (
    value &&
    typeof value === "object" &&
    "chars" in value &&
    "sha256" in value &&
    typeof value.chars === "number" &&
    typeof value.sha256 === "string"
  ) {
    return digestFromExisting(value as { chars: number; sha256: string });
  }
  const serialized = JSON.stringify(value);
  return digest(serialized === undefined ? String(value) : serialized);
}

function sanitizeMetadata(metadata: Record<string, unknown> | undefined): TrajectoryEventMetadata {
  if (!metadata) return {};
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([, value]) => value !== undefined)
      .slice(0, 32)
      .map(([key, value]) => [key, sanitizeMetadataValue(key, value)]),
  );
}

function assertDigest(value: unknown, location: string, full = false): value is TrajectoryTextDigest {
  if (!value || typeof value !== "object") return false;
  const digestValue = value as Record<string, unknown>;
  const keys = Object.keys(digestValue);
  if (keys.some((key) => !["chars", "utf8Bytes", "sha256"].includes(key))) return false;
  const hashLengthValid = full
    ? typeof digestValue.sha256 === "string" && DIGEST_PATTERN.test(digestValue.sha256) && digestValue.sha256.length === 64
    : typeof digestValue.sha256 === "string" && digestValue.sha256.length >= 12 && digestValue.sha256.length <= 64;
  return (
    Number.isInteger(digestValue.chars) &&
    (digestValue.chars as number) >= 0 &&
    Number.isInteger(digestValue.utf8Bytes) &&
    (digestValue.utf8Bytes as number) >= 0 &&
    hashLengthValid &&
    /^[a-f0-9]+$/.test(digestValue.sha256 as string)
  );
}

function assertSafeRecordString(value: unknown, location: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && SAFE_IDENTIFIER.test(value);
}

function validateMetadata(value: unknown, location: string, errors: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${location} must be an object.`);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (!assertSafeRecordString(key, `${location}.${key}`)) {
      errors.push(`${location} contains an invalid metadata key.`);
    }
    if (typeof item === "string") {
      if (EVENT_TEXT_KEYS.has(key) || !SAFE_METADATA_KEYS.has(key) || !SAFE_IDENTIFIER.test(item)) {
        errors.push(`${location}.${key} contains raw or unsupported text.`);
      }
    } else if (typeof item === "number") {
      if (!Number.isFinite(item) || item < 0) errors.push(`${location}.${key} must be a non-negative number.`);
    } else if (
      typeof item !== "boolean" &&
      !assertDigest(item, `${location}.${key}`)
    ) {
      errors.push(`${location}.${key} must be a scalar or digest.`);
    }
  }
}

function validationErrors(record: unknown): string[] {
  const errors: string[] = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return ["trajectory must be an object."];
  }
  const value = record as Record<string, unknown>;
  const requiredKeys = [
    "schemaVersion",
    "recordType",
    "trajectoryId",
    "privacy",
    "task",
    "context",
    "events",
    "selectedCapabilities",
    "usageDeltas",
    "guardrailOutcomes",
    "verificationEvidence",
    "userCorrections",
  ];
  for (const key of Object.keys(value)) {
    if (![...requiredKeys, "verificationDecision"].includes(key)) errors.push(`trajectory has unsupported field ${key}.`);
  }
  if (value.schemaVersion !== TRAJECTORY_SCHEMA_VERSION) errors.push("schemaVersion is unsupported.");
  if (value.recordType !== TRAJECTORY_RECORD_TYPE) errors.push("recordType is unsupported.");
  if (!assertSafeRecordString(value.trajectoryId, "trajectoryId")) errors.push("trajectoryId is invalid.");
  if (
    JSON.stringify(value.privacy) !==
    JSON.stringify({
      rawContent: false,
      rawToolData: false,
      personalData: false,
      replayExecutesTools: false,
      replayUsesLiveServices: false,
      replayUsesComputerUse: false,
    })
  ) {
    errors.push("privacy contract must explicitly disable raw data and live replay.");
  }
  const task = value.task as Record<string, unknown> | undefined;
  if (!task || typeof task !== "object") {
    errors.push("task metadata is required.");
  } else {
    for (const key of Object.keys(task)) {
      if (!["taskId", "goal", "kind", "model", "effort"].includes(key)) errors.push(`task has unsupported field ${key}.`);
    }
    if (!assertDigest(task.taskId, "task.taskId", true)) errors.push("task.taskId must be a full digest.");
    if (!assertDigest(task.goal, "task.goal", true)) errors.push("task.goal must be a full digest.");
    if (!assertSafeRecordString(task.kind, "task.kind") || !TASK_KINDS.has(task.kind as string)) errors.push("task.kind is invalid.");
    for (const field of ["model", "effort"] as const) {
      if (task[field] !== undefined && !assertSafeRecordString(task[field], `task.${field}`)) {
        errors.push(`task.${field} is invalid.`);
      }
    }
  }
  const context = value.context as Record<string, unknown> | undefined;
  if (!context || typeof context !== "object" || Array.isArray(context) || !Array.isArray(context.segments)) {
    errors.push("context metadata with segments is required.");
  } else {
    for (const key of Object.keys(context)) {
      if (!["packetVersion", "itemCount", "usedContentChars", "segments"].includes(key)) errors.push(`context has unsupported field ${key}.`);
    }
    for (const [index, segment] of context.segments.entries()) {
      if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
        errors.push(`context.segments[${index}] must be an object.`);
        continue;
      }
      const item = segment as Record<string, unknown>;
      for (const key of Object.keys(item)) {
        if (!["name", "source", "provenance", "measurement", "chars", "utf8Bytes", "sha256", "itemCount", "budgetChars", "truncated"].includes(key)) {
          errors.push(`context.segments[${index}] has unsupported field ${key}.`);
        }
      }
      for (const field of ["name", "source", "provenance", "measurement"] as const) {
        if (!assertSafeRecordString(item[field], `context.segments[${index}].${field}`)) {
          errors.push(`context.segments[${index}].${field} is invalid.`);
        }
      }
      if (!CONTEXT_PROVENANCE.has(String(item.provenance))) errors.push(`context.segments[${index}].provenance is invalid.`);
      if (!CONTEXT_MEASUREMENTS.has(String(item.measurement))) errors.push(`context.segments[${index}].measurement is invalid.`);
      for (const field of ["chars", "utf8Bytes", "itemCount", "budgetChars"] as const) {
        if (item[field] !== undefined && (!Number.isInteger(item[field]) || (item[field] as number) < 0)) {
          errors.push(`context.segments[${index}].${field} is invalid.`);
        }
      }
      if (item.sha256 !== undefined && (typeof item.sha256 !== "string" || !DIGEST_PATTERN.test(item.sha256))) {
        errors.push(`context.segments[${index}].sha256 is invalid.`);
      }
    }
  }
  if (!Array.isArray(value.events)) errors.push("events must be an array.");
  else {
    let priorSequence = 0;
    for (const [index, event] of value.events.entries()) {
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        errors.push(`events[${index}] must be an object.`);
        continue;
      }
      const item = event as Record<string, unknown>;
      for (const key of Object.keys(item)) {
        if (!["sequence", "type", "elapsedMs", "metadata"].includes(key)) errors.push(`events[${index}] has unsupported field ${key}.`);
      }
      if (!Number.isInteger(item.sequence) || (item.sequence as number) <= priorSequence) {
        errors.push(`events[${index}].sequence must increase monotonically.`);
      }
      priorSequence = typeof item.sequence === "number" ? item.sequence : priorSequence;
      if (!assertSafeRecordString(item.type, `events[${index}].type`)) errors.push(`events[${index}].type is invalid.`);
      if (item.elapsedMs !== undefined && (typeof item.elapsedMs !== "number" || item.elapsedMs < 0)) {
        errors.push(`events[${index}].elapsedMs is invalid.`);
      }
      validateMetadata(item.metadata, `events[${index}].metadata`, errors);
    }
  }
  for (const field of ["selectedCapabilities", "usageDeltas", "guardrailOutcomes", "verificationEvidence", "userCorrections"] as const) {
    if (!Array.isArray(value[field])) errors.push(`${field} must be an array.`);
  }
  if (Array.isArray(value.selectedCapabilities)) {
    for (const [index, rawCapability] of value.selectedCapabilities.entries()) {
      if (!rawCapability || typeof rawCapability !== "object" || Array.isArray(rawCapability)) {
        errors.push(`selectedCapabilities[${index}] must be an object.`);
        continue;
      }
      const capability = rawCapability as Record<string, unknown>;
      for (const key of Object.keys(capability)) {
        if (!["id", "source", "reason"].includes(key)) errors.push(`selectedCapabilities[${index}] has unsupported field ${key}.`);
      }
      if (!assertSafeRecordString(capability.id, `selectedCapabilities[${index}].id`)) errors.push(`selectedCapabilities[${index}].id is invalid.`);
      if (typeof capability.source !== "string" || !CAPABILITY_SOURCES.has(capability.source)) errors.push(`selectedCapabilities[${index}].source is invalid.`);
      if (!assertDigest(capability.reason, `selectedCapabilities[${index}].reason`)) errors.push(`selectedCapabilities[${index}].reason must be a digest.`);
    }
  }
  if (Array.isArray(value.usageDeltas)) {
    for (const [index, rawDelta] of value.usageDeltas.entries()) {
      if (!rawDelta || typeof rawDelta !== "object" || Array.isArray(rawDelta)) {
        errors.push(`usageDeltas[${index}] must be an object.`);
        continue;
      }
      const delta = rawDelta as Record<string, unknown>;
      const fields = ["sequence", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
      for (const key of Object.keys(delta)) {
        if (!fields.includes(key)) errors.push(`usageDeltas[${index}] has unsupported field ${key}.`);
      }
      for (const field of fields) {
        if (!Number.isInteger(delta[field]) || (delta[field] as number) < 0) errors.push(`usageDeltas[${index}].${field} is invalid.`);
      }
    }
  }
  if (Array.isArray(value.guardrailOutcomes)) {
    for (const [index, rawGuardrail] of value.guardrailOutcomes.entries()) {
      if (!rawGuardrail || typeof rawGuardrail !== "object" || Array.isArray(rawGuardrail)) {
        errors.push(`guardrailOutcomes[${index}] must be an object.`);
        continue;
      }
      const guardrail = rawGuardrail as Record<string, unknown>;
      const fields = ["sequence", "version", "action", "reason", "observed", "limit", "summaryDigest"];
      for (const key of Object.keys(guardrail)) {
        if (!fields.includes(key)) errors.push(`guardrailOutcomes[${index}] has unsupported field ${key}.`);
      }
      for (const field of ["version", "observed", "limit"] as const) {
        if (!Number.isInteger(guardrail[field]) || (guardrail[field] as number) < 0) errors.push(`guardrailOutcomes[${index}].${field} is invalid.`);
      }
      if (guardrail.sequence !== undefined && (!Number.isInteger(guardrail.sequence) || (guardrail.sequence as number) < 1)) errors.push(`guardrailOutcomes[${index}].sequence is invalid.`);
      if (!["stop", "summarize", "needs-decision"].includes(String(guardrail.action))) errors.push(`guardrailOutcomes[${index}].action is invalid.`);
      if (!["tokens", "time", "tool-calls", "turns", "loop", "repeated-failures"].includes(String(guardrail.reason))) errors.push(`guardrailOutcomes[${index}].reason is invalid.`);
      if (!assertDigest(guardrail.summaryDigest, `guardrailOutcomes[${index}].summaryDigest`)) errors.push(`guardrailOutcomes[${index}].summaryDigest must be a digest.`);
    }
  }
  const verificationDecision = value.verificationDecision as Record<string, unknown> | undefined;
  if (verificationDecision !== undefined) {
    if (!verificationDecision || typeof verificationDecision !== "object" || Array.isArray(verificationDecision)) {
      errors.push("verificationDecision must be an object.");
    } else {
      for (const key of Object.keys(verificationDecision)) {
        if (!["version", "status", "reasonCodes", "evidence"].includes(key)) errors.push(`verificationDecision has unsupported field ${key}.`);
      }
      if (!Number.isInteger(verificationDecision.version) || (verificationDecision.version as number) < 1) errors.push("verificationDecision.version is invalid.");
      if (verificationDecision.status !== "verified" && verificationDecision.status !== "unverified") errors.push("verificationDecision.status is invalid.");
      if (!Array.isArray(verificationDecision.reasonCodes)) errors.push("verificationDecision.reasonCodes must be an array.");
      else for (const [index, reasonCode] of verificationDecision.reasonCodes.entries()) {
        if (!assertSafeRecordString(reasonCode, `verificationDecision.reasonCodes[${index}]`)) errors.push(`verificationDecision.reasonCodes[${index}] is invalid.`);
      }
      const counts = verificationDecision.evidence as Record<string, unknown> | undefined;
      if (!counts || typeof counts !== "object" || Array.isArray(counts)) errors.push("verificationDecision.evidence must be an object.");
      else {
        for (const key of Object.keys(counts)) {
          if (!["considered", "supporting", "contradictory", "directSupporting"].includes(key)) errors.push(`verificationDecision.evidence has unsupported field ${key}.`);
        }
        for (const field of ["considered", "supporting", "contradictory", "directSupporting"] as const) {
          if (!Number.isInteger(counts[field]) || (counts[field] as number) < 0) errors.push(`verificationDecision.evidence.${field} is invalid.`);
        }
      }
    }
  }
  if (Array.isArray(value.verificationEvidence)) {
    for (const [index, rawEvidence] of value.verificationEvidence.entries()) {
      if (!rawEvidence || typeof rawEvidence !== "object" || Array.isArray(rawEvidence)) {
        errors.push(`verificationEvidence[${index}] must be an object.`);
        continue;
      }
      const evidence = rawEvidence as Record<string, unknown>;
      const fields = ["id", "kind", "source", "polarity", "strength", "statementDigest"];
      for (const key of Object.keys(evidence)) {
        if (!fields.includes(key)) errors.push(`verificationEvidence[${index}] has unsupported field ${key}.`);
      }
      for (const field of ["id", "kind", "source"] as const) {
        if (!assertSafeRecordString(evidence[field], `verificationEvidence[${index}].${field}`)) errors.push(`verificationEvidence[${index}].${field} is invalid.`);
      }
      if (!EVIDENCE_KINDS.has(String(evidence.kind))) errors.push(`verificationEvidence[${index}].kind is invalid.`);
      if (evidence.polarity !== "supports" && evidence.polarity !== "contradicts") errors.push(`verificationEvidence[${index}].polarity is invalid.`);
      if (evidence.strength !== "direct" && evidence.strength !== "indirect") errors.push(`verificationEvidence[${index}].strength is invalid.`);
      if (!assertDigest(evidence.statementDigest, `verificationEvidence[${index}].statementDigest`)) errors.push(`verificationEvidence[${index}].statementDigest must be a digest.`);
    }
  }
  if (Array.isArray(value.userCorrections)) {
    for (const [index, rawCorrection] of value.userCorrections.entries()) {
      if (!rawCorrection || typeof rawCorrection !== "object" || Array.isArray(rawCorrection)) {
        errors.push(`userCorrections[${index}] must be an object.`);
        continue;
      }
      const correction = rawCorrection as Record<string, unknown>;
      for (const key of Object.keys(correction)) {
        if (!["sequence", "kind", "correctionDigest"].includes(key)) errors.push(`userCorrections[${index}] has unsupported field ${key}.`);
      }
      if (!Number.isInteger(correction.sequence) || (correction.sequence as number) < 1) errors.push(`userCorrections[${index}].sequence is invalid.`);
      if (!["approval", "scope-change", "stop", "cancel", "resume", "retry", "other"].includes(String(correction.kind))) errors.push(`userCorrections[${index}].kind is invalid.`);
      if (!assertDigest(correction.correctionDigest, `userCorrections[${index}].correctionDigest`)) errors.push(`userCorrections[${index}].correctionDigest must be a digest.`);
    }
  }
  return errors;
}

export function validateTrajectoryRecord(record: unknown): string[] {
  return validationErrors(record);
}

export function assertValidTrajectoryRecord(record: unknown): asserts record is TrajectoryRecord {
  const errors = validationErrors(record);
  if (errors.length > 0) throw new Error(`Invalid trajectory record:\n${errors.join("\n")}`);
}

function defaultTrajectoryId(taskId: string, goal: string): string {
  return createHash("sha256").update(`${taskId}\n${goal}`, "utf8").digest("hex").slice(0, 24);
}

function cloneUsage(usage: TokenUsage): TokenUsage {
  return { ...usage };
}

export class TrajectoryRecorder {
  private readonly record: TrajectoryRecord;
  private previousUsage: TokenUsage | undefined;
  private lastEventSequence = 0;

  constructor(input: TrajectoryRecorderInput) {
    const kind = input.kind ?? "general";
    this.record = {
      schemaVersion: TRAJECTORY_SCHEMA_VERSION,
      recordType: TRAJECTORY_RECORD_TYPE,
      trajectoryId: identifier(input.trajectoryId ?? defaultTrajectoryId(input.taskId, input.goal), "trajectoryId"),
      privacy: {
        rawContent: false,
        rawToolData: false,
        personalData: false,
        replayExecutesTools: false,
        replayUsesLiveServices: false,
        replayUsesComputerUse: false,
      },
      task: {
        taskId: digest(input.taskId),
        goal: digest(input.goal),
        kind,
        ...(input.model ? { model: identifier(input.model, "model") } : {}),
        ...(input.effort ? { effort: identifier(input.effort, "effort") } : {}),
      },
      context: { segments: [] },
      events: [],
      selectedCapabilities: [],
      usageDeltas: [],
      guardrailOutcomes: [],
      verificationEvidence: [],
      userCorrections: [],
    };
  }

  recordContextMetadata(input: TrajectoryContextMetadataInput): void {
    this.record.context = {
      ...(input.packetVersion ? { packetVersion: identifier(input.packetVersion, "packetVersion") } : {}),
      ...(input.itemCount !== undefined ? { itemCount: nonNegativeInteger(input.itemCount, "itemCount") } : {}),
      ...(input.usedContentChars !== undefined
        ? { usedContentChars: nonNegativeInteger(input.usedContentChars, "usedContentChars") }
        : {}),
      segments: input.segments.map((segment) => ({
        name: identifier(segment.name, "context segment name"),
        source: identifier(segment.source, "context segment source"),
        provenance: segment.provenance,
        measurement: segment.measurement,
        ...(segment.chars !== undefined ? { chars: nonNegativeInteger(segment.chars, "segment chars") } : {}),
        ...(segment.utf8Bytes !== undefined
          ? { utf8Bytes: nonNegativeInteger(segment.utf8Bytes, "segment utf8Bytes") }
          : {}),
        ...(segment.sha256 ? { sha256: segment.sha256 } : {}),
        ...(segment.itemCount !== undefined ? { itemCount: nonNegativeInteger(segment.itemCount, "segment itemCount") } : {}),
        ...(segment.budgetChars !== undefined
          ? { budgetChars: nonNegativeInteger(segment.budgetChars, "segment budgetChars") }
          : {}),
        ...(segment.truncated !== undefined ? { truncated: segment.truncated } : {}),
      })),
    };
  }

  recordCapabilities(manifest: Pick<ExecutionCapabilityManifest, "selectedCapabilityIds" | "capabilities">): void {
    this.record.selectedCapabilities = manifest.capabilities
      .filter((capability) => manifest.selectedCapabilityIds.includes(capability.id))
      .map((capability) => ({
        id: identifier(capability.id, "capability id"),
        source: capability.source,
        reason: digest(capability.reason),
      }));
  }

  recordLifecycleEvent(input: TrajectoryLifecycleEventInput): void {
    if (!Number.isInteger(input.sequence) || input.sequence <= this.lastEventSequence) {
      throw new Error("Trajectory lifecycle event sequences must increase monotonically.");
    }
    this.lastEventSequence = input.sequence;
    this.record.events.push({
      sequence: input.sequence,
      type: identifier(input.type, "event type"),
      ...(input.elapsedMs !== undefined
        ? { elapsedMs: nonNegativeInteger(input.elapsedMs, "elapsedMs") }
        : {}),
      metadata: sanitizeMetadata(input.metadata),
    });
  }

  recordKernelEvent(event: KernelLifecycleEvent, elapsedMs?: number): void {
    const metadata: Record<string, unknown> = {};
    switch (event.type) {
      case "kernel.started":
        metadata.taskKind = event.taskKind;
        break;
      case "kernel.context_prepared":
        metadata.packetVersion = event.packetVersion;
        metadata.contextItemCount = event.contextItemCount;
        metadata.usedContentChars = event.usedContentChars;
        break;
      case "kernel.capabilities_selected":
        metadata.manifestVersion = event.manifestVersion;
        metadata.workerId = event.workerId;
        metadata.selectedCapabilityCount = event.selectedCapabilityIds.length;
        break;
      case "kernel.permission_decided":
        metadata.decision = event.decision;
        metadata.reason = event.reason;
        if (event.authorityExpiresAt) metadata.authorityExpiresAt = event.authorityExpiresAt;
        break;
      case "kernel.worker_started":
        metadata.workerId = event.workerId;
        break;
      case "kernel.worker_progress":
        metadata.message = event.message;
        break;
      case "kernel.worker_completed":
        metadata.verifiedClaim = event.verifiedClaim;
        metadata.reconciliationRequired = event.reconciliationRequired;
        break;
      case "kernel.outcome_verified":
        metadata.outcomeStatus = event.outcome.status;
        metadata.artifactCount = event.outcome.artifactCount;
        break;
      case "kernel.outcome_unverified":
        metadata.outcomeStatus = event.outcome.status;
        metadata.reason = event.outcome.reason;
        metadata.artifactCount = event.outcome.artifactCount;
        break;
      case "kernel.guardrail_triggered":
        metadata.action = event.outcome.action;
        metadata.guardrailReason = event.outcome.reason;
        metadata.observed = event.outcome.observed;
        metadata.limit = event.outcome.limit;
        this.recordGuardrailOutcome(event.outcome, event.sequence);
        break;
      case "kernel.failed":
        metadata.errorName = event.errorName;
        break;
    }
    this.recordLifecycleEvent({ sequence: event.sequence, type: event.type, elapsedMs, metadata });
  }

  recordUsage(current: TokenUsage, sequence = this.record.usageDeltas.length + 1): void {
    const delta = tokenUsageDelta(current, this.previousUsage);
    this.previousUsage = cloneUsage(current);
    this.record.usageDeltas.push({ sequence, ...cloneUsage(delta) });
  }

  recordGuardrailOutcome(outcome: ExecutionGuardrailOutcome, sequence?: number): void {
    this.record.guardrailOutcomes.push({
      ...(sequence !== undefined ? { sequence } : {}),
      version: outcome.version,
      action: outcome.action,
      reason: outcome.reason,
      observed: outcome.observed,
      limit: outcome.limit,
      summaryDigest: digest(outcome.summary),
    });
  }

  recordVerification(
    decision: VerificationDecision,
    evidence: readonly VerificationEvidence[],
  ): void {
    this.record.verificationDecision = {
      version: decision.version,
      status: decision.status,
      reasonCodes: decision.reasons.map((reason) => identifier(reason.code, "verification reason")),
      evidence: { ...decision.evidence },
    };
    this.record.verificationEvidence = evidence.map((item) => ({
      id: identifier(item.id, "verification evidence id"),
      kind: item.kind,
      source: identifier(item.source, "verification evidence source"),
      polarity: item.polarity,
      strength: item.strength,
      statementDigest: digest(item.statement),
    }));
  }

  recordUserCorrection(
    kind: UserCorrectionKind,
    correction: string,
    sequence = Math.max(this.record.userCorrections.length + 1, this.lastEventSequence + 1),
  ): void {
    this.recordLifecycleEvent({
      sequence,
      type: "user.correction",
      metadata: { kind },
    });
    this.record.userCorrections.push({
      sequence,
      kind,
      correctionDigest: digest(correction),
    });
  }

  toRecord(): TrajectoryRecord {
    const record = cloneRecord(this.record);
    assertValidTrajectoryRecord(record);
    return record;
  }
}

export function createTrajectoryRecorder(input: TrajectoryRecorderInput): TrajectoryRecorder {
  return new TrajectoryRecorder(input);
}

export type TrajectoryReplayState =
  | "initial"
  | "waiting_approval"
  | "approved"
  | "running"
  | "suspended"
  | "needs_decision"
  | "completed"
  | "failed"
  | "cancelled";

export interface TrajectoryReplayFixture {
  id: string;
  expectedTerminalState: Exclude<TrajectoryReplayState, "initial" | "approved">;
  requiredEventTypes: readonly string[];
  forbiddenEventTypes: readonly string[];
}

export const TRAJECTORY_REPLAY_FIXTURES: Readonly<Record<string, TrajectoryReplayFixture>> = {
  "approval-pause": {
    id: "approval-pause",
    expectedTerminalState: "needs_decision",
    requiredEventTypes: ["task.created", "kernel.permission_decided", "task.needs_decision"],
    forbiddenEventTypes: ["kernel.worker_started", "tool.executed", "connector.executed", "computer.executed"],
  },
  "stop-cancel": {
    id: "stop-cancel",
    expectedTerminalState: "cancelled",
    requiredEventTypes: ["task.created", "task.approved", "kernel.permission_decided", "kernel.worker_started", "task.cancelled"],
    forbiddenEventTypes: ["work.after_cancel", "connector.executed", "computer.executed"],
  },
  "verified-completion": {
    id: "verified-completion",
    expectedTerminalState: "completed",
    requiredEventTypes: ["task.created", "task.approved", "kernel.permission_decided", "kernel.worker_started", "kernel.outcome_verified", "task.completed"],
    forbiddenEventTypes: ["connector.executed", "computer.executed"],
  },
  "guardrail-decision": {
    id: "guardrail-decision",
    expectedTerminalState: "needs_decision",
    requiredEventTypes: ["task.created", "task.approved", "kernel.permission_decided", "kernel.worker_started", "kernel.guardrail_triggered", "task.needs_decision"],
    forbiddenEventTypes: ["task.completed", "connector.executed", "computer.executed"],
  },
  "corrected-completion": {
    id: "corrected-completion",
    expectedTerminalState: "completed",
    requiredEventTypes: ["task.needs_decision", "user.correction", "task.approved", "kernel.outcome_verified", "task.completed"],
    forbiddenEventTypes: ["connector.executed", "computer.executed"],
  },
} as const;

export interface TrajectoryReplayResult {
  schemaVersion: typeof TRAJECTORY_SCHEMA_VERSION;
  replayVersion: typeof TRAJECTORY_SCHEMA_VERSION;
  trajectoryId: string;
  fixtureId: string;
  status: "passed" | "failed";
  terminalState: TrajectoryReplayState;
  visitedStates: TrajectoryReplayState[];
  decisionPath: Array<{ sequence: number; type: string; decision?: string; kind?: string }>;
  violations: string[];
  toolExecutionCount: 0;
  liveServiceCallCount: 0;
  computerUseCallCount: 0;
}

function metadataString(event: TrajectoryLifecycleEvent, key: string): string | undefined {
  const value = event.metadata[key];
  return typeof value === "string" ? value : undefined;
}

function isTerminal(state: TrajectoryReplayState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

export function replayTrajectory(
  record: TrajectoryRecord,
  fixture: TrajectoryReplayFixture | string,
): TrajectoryReplayResult {
  const fixtureValue = typeof fixture === "string" ? TRAJECTORY_REPLAY_FIXTURES[fixture] : fixture;
  const violations = validateTrajectoryRecord(record);
  if (!fixtureValue) violations.push(`Unknown replay fixture: ${String(fixture)}.`);
  const selectedFixture = fixtureValue ?? {
    id: String(fixture),
    expectedTerminalState: "failed" as const,
    requiredEventTypes: [],
    forbiddenEventTypes: [],
  };
  let state: TrajectoryReplayState = "initial";
  let authority: "unknown" | "allow" | "ask" | "deny" = "unknown";
  const visitedStates: TrajectoryReplayState[] = [state];
  const decisionPath: TrajectoryReplayResult["decisionPath"] = [];
  const events = Array.isArray(record.events) ? record.events : [];
  const eventTypes = new Set(events.map((event) => event.type));

  for (const eventType of selectedFixture.requiredEventTypes) {
    if (!eventTypes.has(eventType)) violations.push(`Required event is missing: ${eventType}.`);
  }
  for (const eventType of selectedFixture.forbiddenEventTypes) {
    if (eventTypes.has(eventType)) violations.push(`Forbidden event was recorded: ${eventType}.`);
  }

  const move = (next: TrajectoryReplayState) => {
    state = next;
    visitedStates.push(next);
  };
  const currentState = () => state;
  const currentAuthority = () => authority;
  for (const event of events) {
    if (EXECUTION_EVENT.test(event.type)) {
      violations.push(`Replay refuses execution event: ${event.type}.`);
    }
    const decision = metadataString(event, "decision");
    const kind = metadataString(event, "kind");
    if (decision || event.type === "user.correction" || event.type === "kernel.guardrail_triggered") {
      decisionPath.push({ sequence: event.sequence, type: event.type, ...(decision ? { decision } : {}), ...(kind ? { kind } : {}) });
    }
    if (isTerminal(currentState()) && event.type !== "task.completed") {
      violations.push(`Event ${event.type} occurred after terminal state ${currentState()}.`);
      continue;
    }
    switch (event.type) {
      case "task.created":
        if (currentState() !== "initial") violations.push("task.created must be the first state transition.");
        move("waiting_approval");
        break;
      case "task.approved":
        if (currentState() !== "waiting_approval" && currentState() !== "needs_decision" && currentState() !== "suspended") {
          violations.push(`task.approved is invalid from ${currentState()}.`);
        }
        move("approved");
        break;
      case "kernel.permission_decided":
        if (!decision || !["allow", "ask", "deny"].includes(decision)) {
          violations.push("kernel.permission_decided must contain allow, ask, or deny.");
        } else {
          authority = decision as typeof authority;
          if (decision === "ask") move("needs_decision");
          if (decision === "deny") move("failed");
          if (decision === "allow" && currentState() === "initial") move("approved");
        }
        break;
      case "kernel.worker_started":
        if (currentAuthority() !== "allow") violations.push("A worker cannot start without an allow decision.");
        if (currentState() !== "approved" && currentState() !== "suspended") violations.push(`kernel.worker_started is invalid from ${currentState()}.`);
        move("running");
        break;
      case "task.paused":
        if (currentState() !== "running") violations.push(`task.paused is invalid from ${currentState()}.`);
        move("suspended");
        break;
      case "task.resumed":
      case "task.recovery_revalidated":
        if (currentState() !== "suspended" || currentAuthority() !== "allow") violations.push(`${event.type} requires suspended state and allow authority.`);
        move("approved");
        break;
      case "kernel.guardrail_triggered":
        move("needs_decision");
        break;
      case "task.needs_decision":
        move("needs_decision");
        break;
      case "user.correction":
        if (currentState() !== "needs_decision") violations.push("user.correction must answer a pending decision.");
        break;
      case "kernel.outcome_verified":
        if (currentState() !== "running") violations.push(`kernel.outcome_verified is invalid from ${currentState()}.`);
        move("completed");
        break;
      case "task.completed":
        if (currentState() !== "completed") violations.push(`task.completed is invalid from ${currentState()}.`);
        move("completed");
        break;
      case "kernel.outcome_unverified":
        if (currentState() !== "running") violations.push(`kernel.outcome_unverified is invalid from ${currentState()}.`);
        move("needs_decision");
        break;
      case "kernel.failed":
        move("failed");
        break;
      case "task.cancelled":
        if (isTerminal(currentState())) violations.push(`task.cancelled is invalid from ${currentState()}.`);
        move("cancelled");
        break;
      default:
        break;
    }
  }
  if (currentState() !== selectedFixture.expectedTerminalState) {
    violations.push(`Expected terminal state ${selectedFixture.expectedTerminalState}; received ${currentState()}.`);
  }
  return {
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    replayVersion: TRAJECTORY_SCHEMA_VERSION,
    trajectoryId: record.trajectoryId,
    fixtureId: selectedFixture.id,
    status: violations.length === 0 ? "passed" : "failed",
    terminalState: currentState(),
    visitedStates,
    decisionPath,
    violations,
    toolExecutionCount: 0,
    liveServiceCallCount: 0,
    computerUseCallCount: 0,
  };
}
