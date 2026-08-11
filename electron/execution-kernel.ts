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
  ExecutionGuardrailTracker,
  type ExecutionBudgets,
} from "./execution-guardrails.js";
import type {
  ExecutionResult,
  TaskExecutionOptions,
  TaskExecutor,
  TokenUsage,
  AccountUsage,
  ExecutionGuardrailOutcome,
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
  | { type: "kernel.worker_started"; workerId: ExecutionCapabilityManifest["worker"]["id"] }
  | { type: "kernel.worker_progress"; message: ReturnType<typeof textMeta> }
  | { type: "kernel.worker_completed"; verifiedClaim: boolean; reconciliationRequired: boolean }
  | { type: "kernel.outcome_verified"; outcome: VerifiedOutcome }
  | { type: "kernel.outcome_unverified"; outcome: UnverifiedOutcome }
  | {
      type: "kernel.guardrail_triggered";
      outcome: ExecutionGuardrailOutcome;
      counters: ReturnType<ExecutionGuardrailTracker["snapshot"]>;
    }
  | { type: "kernel.failed"; errorName: string };

export type KernelLifecycleEvent = KernelEventBase & KernelLifecycleEventData;

export interface MinimalExecutionKernelOptions {
  selectConnectorCapabilities?: (request: {
    task: string;
    requestedCapabilityIds: readonly string[];
  }) => CapabilityManifest;
  onEvent?: (event: KernelLifecycleEvent) => void;
  budgets?: Partial<ExecutionBudgets>;
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
    const guardrails = new ExecutionGuardrailTracker(this.options.budgets);
    const workerController = new AbortController();
    let guardrailOutcome: ExecutionGuardrailOutcome | undefined;
    let resolveGuardrail: ((result: ExecutionResult) => void) | undefined;
    const guardrailResult = new Promise<ExecutionResult>((resolve) => {
      resolveGuardrail = resolve;
    });
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

    const stopForGuardrail = (outcome: ExecutionGuardrailOutcome | undefined) => {
      if (!outcome || guardrailOutcome) return;
      guardrailOutcome = outcome;
      const counters = guardrails.snapshot();
      emit({ type: "kernel.guardrail_triggered", outcome, counters });
      workerController.abort();
      resolveGuardrail?.({
        summary: outcome.summary,
        verified: false,
        guardrailOutcome: outcome,
      });
    };
    const observeBudget = (
      event: Parameters<ExecutionGuardrailTracker["observe"]>[0],
    ) => stopForGuardrail(guardrails.observe(event));
    const stopOnParentAbort = () => workerController.abort();
    if (signal.aborted) workerController.abort();
    else signal.addEventListener("abort", stopOnParentAbort, { once: true });
    const timeLimit = setTimeout(
      () => stopForGuardrail(guardrails.expireTime()),
      guardrails.budgets.maxDurationMs,
    );

    const finishGuardrail = (outcome: ExecutionGuardrailOutcome) => {
      const result: ExecutionResult = {
        summary: outcome.summary,
        verified: false,
        guardrailOutcome: outcome,
      };
      const normalized = executionResultToOutcome(result);
      emit({ type: "kernel.outcome_unverified", outcome: normalized as UnverifiedOutcome });
      return result;
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

      if (connectorCapabilityId) {
        observeBudget({ type: "tool-started", fingerprint: "connector-task" });
        if (guardrailOutcome) return finishGuardrail(guardrailOutcome);
      }

      emit({ type: "kernel.worker_started", workerId: capabilityManifest.worker.id });
      const workerResult = this.worker.execute(
        contextPacket.purpose.objective,
        workerController.signal,
        (message) => {
          emit({ type: "kernel.worker_progress", message: textMeta(message) });
          progress(message);
        },
        (latestUsage) => {
          usage?.(latestUsage);
          observeBudget({ type: "usage", totalTokens: latestUsage.totalTokens });
        },
        accountUsage,
        {
          ...execution,
          contextPacket,
          capabilityManifest,
          budgetObserver: observeBudget,
        },
      );
      if (guardrailOutcome) return finishGuardrail(guardrailOutcome);
      const result = await Promise.race([workerResult, guardrailResult]);
      if (guardrailOutcome) return finishGuardrail(guardrailOutcome);
      if (result.guardrailOutcome) return finishGuardrail(result.guardrailOutcome);
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
      if (guardrailOutcome) return finishGuardrail(guardrailOutcome);
      emit({
        type: "kernel.failed",
        errorName: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    } finally {
      clearTimeout(timeLimit);
      signal.removeEventListener("abort", stopOnParentAbort);
    }
  }
}
