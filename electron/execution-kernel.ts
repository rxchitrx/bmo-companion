import { randomUUID } from "node:crypto";
import type { CapabilityManifest } from "./capability-selection.js";
import {
  contextPacketTelemetrySegments,
  createTaskContextPacket,
  type TaskContextPacket,
} from "./context-packet.js";
import { recordContextSnapshot } from "./context-telemetry.js";
import { diagnosticLog, textMeta } from "./diagnostics.js";
import {
  boundVerificationEvidence,
  defaultOutcomeVerifier,
  type OutcomeVerifier,
  type VerificationDecision,
  type VerificationEvidence,
} from "./outcome-verifier.js";
import type {
  ExecutionResult,
  TaskExecutionOptions,
  TaskExecutor,
  TokenUsage,
  AccountUsage,
} from "./task-runtime.js";

export const EXECUTION_KERNEL_VERSION = 1 as const;

export interface ExecutionCapabilityManifest {
  version: typeof EXECUTION_KERNEL_VERSION;
  authority: "selection-only";
  worker: {
    id: "codex-task" | "connector-task";
    scope: "one-task";
    maxInstances: 1;
  };
  selectedCapabilityIds: string[];
  capabilities: Array<{
    id: string;
    source: "context-packet" | "connector-selector";
    reason: string;
  }>;
  connectorSelection?: {
    version: CapabilityManifest["version"];
    selectedServiceCount: number;
    selectedActionCount: number;
  };
}

export interface VerifiedOutcome {
  status: "verified";
  summary: string;
  verification: VerificationDecision;
  artifactCount: number;
}

export interface UnverifiedOutcome {
  status: "unverified";
  summary: string;
  reason: Extract<VerificationDecision, { status: "unverified" }>["reasons"][0]["code"];
  verification: VerificationDecision;
  artifactCount: number;
}

export type KernelOutcome = VerifiedOutcome | UnverifiedOutcome;

interface KernelEventBase {
  version: typeof EXECUTION_KERNEL_VERSION;
  runId: string;
  sequence: number;
}

export type KernelLifecycleEventData =
  | { type: "kernel.started"; taskKind: string }
  | {
      type: "kernel.context_prepared";
      packetVersion: TaskContextPacket["schemaVersion"];
      contextItemCount: number;
      usedContentChars: number;
    }
  | {
      type: "kernel.capabilities_selected";
      manifestVersion: ExecutionCapabilityManifest["version"];
      workerId: ExecutionCapabilityManifest["worker"]["id"];
      selectedCapabilityIds: string[];
    }
  | { type: "kernel.worker_started"; workerId: ExecutionCapabilityManifest["worker"]["id"] }
  | { type: "kernel.worker_progress"; message: ReturnType<typeof textMeta> }
  | { type: "kernel.worker_completed"; verifiedClaim: boolean; reconciliationRequired: boolean }
  | { type: "kernel.outcome_verified"; outcome: VerifiedOutcome }
  | { type: "kernel.outcome_unverified"; outcome: UnverifiedOutcome }
  | { type: "kernel.failed"; errorName: string };

export type KernelLifecycleEvent = KernelEventBase & KernelLifecycleEventData;

export interface MinimalExecutionKernelOptions {
  selectConnectorCapabilities?: (request: {
    task: string;
    requestedCapabilityIds: readonly string[];
  }) => CapabilityManifest;
  verifier?: OutcomeVerifier;
  onEvent?: (event: KernelLifecycleEvent) => void;
}

export function createExecutionCapabilityManifest(
  packet: TaskContextPacket,
  connectorSelection?: CapabilityManifest,
  requiredConnectorCapabilityId?: string,
): ExecutionCapabilityManifest {
  if (packet.purpose.taskKind === "connector") {
    const selectedCapabilityIds = (connectorSelection?.selectedCapabilityIds ?? [])
      .filter((id) => id === requiredConnectorCapabilityId);
    return {
      version: EXECUTION_KERNEL_VERSION,
      authority: "selection-only",
      worker: { id: "connector-task", scope: "one-task", maxInstances: 1 },
      selectedCapabilityIds,
      capabilities: selectedCapabilityIds.map((id) => ({
        id,
        source: "connector-selector",
        reason: "Task 4 selected this exact allowlisted connector action for the scoped Task.",
      })),
      ...(connectorSelection
        ? {
            connectorSelection: {
              version: connectorSelection.version,
              selectedServiceCount: connectorSelection.capabilities.length,
              selectedActionCount: connectorSelection.selectedCapabilityIds.length,
            },
          }
        : {}),
    };
  }
  const capabilities = packet.capabilityReferences.map((reference) => ({
    id: reference.id,
    source: "context-packet" as const,
    reason: reference.reason,
  }));
  return {
    version: EXECUTION_KERNEL_VERSION,
    authority: "selection-only",
    worker: { id: "codex-task", scope: "one-task", maxInstances: 1 },
    selectedCapabilityIds: capabilities.map((capability) => capability.id),
    capabilities,
  };
}

export function renderExecutionCapabilityManifest(
  manifest: ExecutionCapabilityManifest,
) {
  return `[BMO EXECUTION CAPABILITY MANIFEST v${manifest.version}]\n${JSON.stringify(manifest, null, 2)}`;
}

function legacyWorkerEvidence(
  result: ExecutionResult,
  workerId: ExecutionCapabilityManifest["worker"]["id"],
): VerificationEvidence[] {
  if (result.verificationEvidence !== undefined) {
    return [...result.verificationEvidence];
  }
  if (!result.verified) return [];
  return [{
    id: `${workerId}.verification-contract`,
    kind: "worker-contract",
    source: workerId,
    polarity: "supports",
    strength: "direct",
    statement: "The scoped worker reported that its existing direct verification contract passed.",
  }];
}

function verificationEvidence(
  result: ExecutionResult,
  workerId: ExecutionCapabilityManifest["worker"]["id"],
) {
  const evidence = legacyWorkerEvidence(result, workerId);
  if (result.reconciliationRequired) {
    evidence.push({
      id: "kernel.reconciliation-required",
      kind: "reconciliation",
      source: "minimal-execution-kernel",
      polarity: "contradicts",
      strength: "direct",
      statement: "The execution result requires reconciliation before completion can be trusted.",
    });
  }
  return evidence;
}

export function executionResultToOutcome(
  result: ExecutionResult,
  verifier: OutcomeVerifier = defaultOutcomeVerifier,
  workerId: ExecutionCapabilityManifest["worker"]["id"] = "codex-task",
): KernelOutcome {
  const summary = result.summary.trim();
  const artifactCount = result.artifacts?.length ?? 0;
  const evidence = verificationEvidence(result, workerId);
  const verification = verifier.verify({
    summary,
    workerClaimedVerified: result.verified,
    reconciliationRequired: result.reconciliationRequired === true,
    evidence,
  });
  if (verification.status === "unverified") {
    const reason = verification.reasons[0].code;
    const fallback = reason === "reconciliation-required"
      ? "UNVERIFIED: The scoped worker requires reconciliation."
      : reason === "missing-summary"
        ? "UNVERIFIED: The scoped worker returned no outcome summary."
        : "UNVERIFIED: The verification evidence was insufficient.";
    return {
      status: "unverified",
      summary: summary || fallback,
      reason,
      verification,
      artifactCount,
    };
  }
  return {
    status: "verified",
    summary,
    verification,
    artifactCount,
  };
}

export class MinimalExecutionKernel implements TaskExecutor {
  constructor(
    private readonly worker: TaskExecutor,
    private readonly options: MinimalExecutionKernelOptions = {},
  ) {}

  async execute(
    goal: string,
    signal: AbortSignal,
    progress: (message: string) => void,
    usage?: (usage: TokenUsage) => void,
    accountUsage?: (usage: AccountUsage) => void,
    execution?: TaskExecutionOptions,
  ): Promise<ExecutionResult> {
    const runId = randomUUID();
    let sequence = 0;
    const emit = (event: KernelLifecycleEventData) => {
      const lifecycleEvent = {
        ...event,
        version: EXECUTION_KERNEL_VERSION,
        runId,
        sequence: ++sequence,
      } as KernelLifecycleEvent;
      diagnosticLog(
        "execution.kernel",
        lifecycleEvent.type,
        lifecycleEvent as unknown as Record<string, unknown>,
      );
      try {
        this.options.onEvent?.(lifecycleEvent);
      } catch (error) {
        diagnosticLog("execution.kernel", "event_observer.failed", {
          eventType: lifecycleEvent.type,
          errorName: error instanceof Error ? error.name : "unknown",
        });
      }
    };

    emit({ type: "kernel.started", taskKind: execution?.kind ?? "general" });
    try {
      const contextPacket = createTaskContextPacket({
        goal,
        kind: execution?.kind,
        retryOf: execution?.retryOf,
        priorOutcome: execution?.priorOutcome,
      });
      recordContextSnapshot(
        "execution.kernel",
        "context.prepared",
        contextPacket,
        contextPacketTelemetrySegments(contextPacket),
        {
          runId,
          contextPacketVersion: contextPacket.schemaVersion,
          contextItemCount: contextPacket.manifest.length,
          contextUsedChars: contextPacket.budget.usedContentChars,
        },
      );
      emit({
        type: "kernel.context_prepared",
        packetVersion: contextPacket.schemaVersion,
        contextItemCount: contextPacket.manifest.length,
        usedContentChars: contextPacket.budget.usedContentChars,
      });

      const connectorCapabilityId = execution?.connectorCall
        ? `${execution.connectorCall.service}.${execution.connectorCall.action}`
        : undefined;
      const connectorSelection = connectorCapabilityId
        ? this.options.selectConnectorCapabilities?.({
            task: contextPacket.purpose.objective,
            requestedCapabilityIds: [connectorCapabilityId],
          })
        : undefined;
      const capabilityManifest = createExecutionCapabilityManifest(
        contextPacket,
        connectorSelection,
        connectorCapabilityId,
      );
      recordContextSnapshot(
        "execution.kernel",
        "capabilities.selected",
        capabilityManifest,
        [{
          name: "execution_capability_manifest",
          source: connectorCapabilityId
            ? "selectCapabilityManifest"
            : "TaskContextPacket.capabilityReferences",
          provenance: "tool",
          value: capabilityManifest,
          inclusionReason: "The scoped worker receives only capabilities selected for this Task.",
        }],
        {
          runId,
          selectedCapabilityCount: capabilityManifest.selectedCapabilityIds.length,
          workerId: capabilityManifest.worker.id,
        },
      );
      emit({
        type: "kernel.capabilities_selected",
        manifestVersion: capabilityManifest.version,
        workerId: capabilityManifest.worker.id,
        selectedCapabilityIds: [...capabilityManifest.selectedCapabilityIds],
      });
      if (
        connectorCapabilityId &&
        !capabilityManifest.selectedCapabilityIds.includes(connectorCapabilityId)
      ) {
        throw new Error(`Selected capability manifest omitted ${connectorCapabilityId}.`);
      }

      emit({ type: "kernel.worker_started", workerId: capabilityManifest.worker.id });
      const result = await this.worker.execute(
        contextPacket.purpose.objective,
        signal,
        (message) => {
          emit({ type: "kernel.worker_progress", message: textMeta(message) });
          progress(message);
        },
        usage,
        accountUsage,
        { ...execution, contextPacket, capabilityManifest },
      );
      emit({
        type: "kernel.worker_completed",
        verifiedClaim: result.verified,
        reconciliationRequired: result.reconciliationRequired === true,
      });
      const outcome = executionResultToOutcome(
        result,
        this.options.verifier ?? defaultOutcomeVerifier,
        capabilityManifest.worker.id,
      );
      const evidence = boundVerificationEvidence(
        verificationEvidence(result, capabilityManifest.worker.id),
      );
      const verificationDecision = outcome.verification;
      emit(outcome.status === "verified"
        ? { type: "kernel.outcome_verified", outcome }
        : { type: "kernel.outcome_unverified", outcome });
      return {
        ...result,
        summary: outcome.summary,
        verified: outcome.status === "verified",
        verificationEvidence: evidence,
        verificationDecision,
      };
    } catch (error) {
      emit({
        type: "kernel.failed",
        errorName: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    }
  }
}
