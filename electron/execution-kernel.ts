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
  createTaskAuthorityScope,
  evaluateTaskAuthority,
  TaskAuthorityError,
} from "./permission-lifecycle.js";
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
  verification: "scoped-worker-contract";
  artifactCount: number;
}

export interface UnverifiedOutcome {
  status: "unverified";
  summary: string;
  reason: "worker-unverified" | "reconciliation-required" | "missing-summary";
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
  | {
      type: "kernel.permission_decided";
      decision: "allow" | "ask" | "deny";
      reason: string;
      authorityExpiresAt?: string;
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
  onEvent?: (event: KernelLifecycleEvent) => void;
  now?: () => Date;
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

export function executionResultToOutcome(result: ExecutionResult): KernelOutcome {
  const summary = result.summary.trim();
  const artifactCount = result.artifacts?.length ?? 0;
  if (result.reconciliationRequired) {
    return {
      status: "unverified",
      summary: summary || "UNVERIFIED: The scoped worker requires reconciliation.",
      reason: "reconciliation-required",
      artifactCount,
    };
  }
  if (!summary) {
    return {
      status: "unverified",
      summary: "UNVERIFIED: The scoped worker returned no outcome summary.",
      reason: "missing-summary",
      artifactCount,
    };
  }
  if (!result.verified) {
    return {
      status: "unverified",
      summary,
      reason: "worker-unverified",
      artifactCount,
    };
  }
  return {
    status: "verified",
    summary,
    verification: "scoped-worker-contract",
    artifactCount,
  };
}

export class MinimalExecutionKernel implements TaskExecutor {
  private activeWorkerRunId: string | null = null;

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

      const authorityScope = createTaskAuthorityScope({
        taskId: execution?.taskId ?? "missing-task-id",
        goal: contextPacket.purpose.objective,
        taskKind: contextPacket.purpose.taskKind,
        workerId: capabilityManifest.worker.id,
        capabilityIds: capabilityManifest.selectedCapabilityIds,
      });
      const authorityPolicy = signal.aborted
        ? { decision: "deny" as const, reason: "authority-revoked" as const }
        : evaluateTaskAuthority(
            execution?.authority,
            authorityScope,
            this.options.now?.() ?? new Date(),
          );
      emit({
        type: "kernel.permission_decided",
        decision: authorityPolicy.decision,
        reason: authorityPolicy.reason,
        authorityExpiresAt: execution?.authority?.expiresAt,
      });
      if (authorityPolicy.decision !== "allow") {
        throw new TaskAuthorityError(authorityPolicy);
      }
      if (this.activeWorkerRunId) {
        throw new Error("A Mac-control worker is already active.");
      }

      this.activeWorkerRunId = runId;
      emit({ type: "kernel.worker_started", workerId: capabilityManifest.worker.id });
      let result: ExecutionResult;
      try {
        result = await this.worker.execute(
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
      } finally {
        if (this.activeWorkerRunId === runId) this.activeWorkerRunId = null;
      }
      emit({
        type: "kernel.worker_completed",
        verifiedClaim: result.verified,
        reconciliationRequired: result.reconciliationRequired === true,
      });
      const outcome = executionResultToOutcome(result);
      emit(outcome.status === "verified"
        ? { type: "kernel.outcome_verified", outcome }
        : { type: "kernel.outcome_unverified", outcome });
      return {
        ...result,
        summary: outcome.summary,
        verified: outcome.status === "verified",
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
