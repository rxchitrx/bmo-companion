import type {
  AccountUsage,
  ExecutionBudgetEvent,
  ExecutionResult,
  TaskExecutionOptions,
  TaskExecutor,
  TaskTiming,
  TokenUsage,
} from "../electron/task-runtime.js";
import {
  MinimalExecutionKernel,
  type KernelLifecycleEvent,
  type MinimalExecutionKernelOptions,
} from "../electron/execution-kernel.js";
import type {
  OutcomeVerifier,
  VerificationEvidence as KernelVerificationEvidence,
} from "../electron/outcome-verifier.js";
import type {
  CanaryAdapter,
  CanaryCase,
  CanaryObservation,
  Measurement,
  VerificationEvidence,
} from "./types";

/** Events a safe runtime may report without exposing raw prompt or result content. */
export interface SafeCanaryRuntimeEvent {
  type: "event" | "tool-call";
  name: string;
  fingerprint?: string;
  failed?: boolean;
  connectorDiscoveryBytes?: number;
}

export interface SafeCanaryRuntimeContext {
  canary: CanaryCase;
  signal: AbortSignal;
  progress: (message: string) => void;
  usage: (usage: TokenUsage) => void;
  accountUsage: (usage: AccountUsage) => void;
  turnStarted: () => void;
  toolCall: (name: string, fingerprint?: string, failed?: boolean) => void;
  event: (name: string, connectorDiscoveryBytes?: number) => void;
  execution?: TaskExecutionOptions;
}

/**
 * A runtime implementation supplied by the host application. It must be
 * read-only and local to the task: the adapter never supplies connector
 * clients, Computer Use leases, or a new authority grant.
 */
export interface SafeCanaryRuntime {
  run(context: SafeCanaryRuntimeContext): Promise<SafeCanaryRuntimeResult>;
}

export interface SafeCanaryRuntimeResult {
  summary: string;
  verified: boolean;
  outputText?: string;
  events?: SafeCanaryRuntimeEvent[];
  toolCallNames?: string[];
  connectorDiscoveryBytes?: number;
  verificationEvidence?: KernelVerificationEvidence[];
  reconciliationRequired?: boolean;
  usage?: TokenUsage;
  accountUsage?: AccountUsage;
  timing?: TaskTiming;
  artifacts?: ExecutionResult["artifacts"];
}

export interface SafeLiveCanaryAdapterOptions
  extends Pick<MinimalExecutionKernelOptions, "selectConnectorCapabilities" | "verifier" | "now" | "budgets"> {
  /** A pre-authorized execution scope. The adapter refuses to create one. */
  execution?: TaskExecutionOptions;
  /** Optional prompt-bound execution scope resolver for a complete canary run. */
  executionForCanary?: (canary: CanaryCase) => TaskExecutionOptions | undefined;
  /** The safe runtime is intentionally injected instead of discovered globally. */
  runtime?: SafeCanaryRuntime;
  /** Optional per-canary runtime resolver for mixed live/local safety paths. */
  runtimeForCanary?: (canary: CanaryCase) => SafeCanaryRuntime | undefined;
  /** Local, non-connector tool names allowed for telemetry. */
  allowedToolNames?: readonly string[];
}

const prohibitedEventNames = new Set([
  "connector-service-used",
  "computer-use-started",
  "external-write",
]);

function measured(value: number, unit: Measurement["unit"]): Measurement {
  return {
    status: "measured",
    unit,
    value: Math.max(0, Math.round(value)),
  };
}

function tokenTelemetry(usage: TokenUsage | undefined) {
  if (!usage) return undefined;
  const values = [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens,
    usage.reasoningOutputTokens, usage.totalTokens];
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0) ||
      usage.cachedInputTokens > usage.inputTokens) return undefined;
  const input = usage.inputTokens;
  const cachedInput = usage.cachedInputTokens;
  return {
    input: measured(input, "tokens"),
    cachedInput: measured(cachedInput, "tokens"),
    freshInput: measured(input - cachedInput, "tokens"),
    output: measured(usage.outputTokens, "tokens"),
    reasoning: measured(usage.reasoningOutputTokens, "tokens"),
  };
}

function kernelEvidence(result: ExecutionResult): VerificationEvidence[] {
  const evidence: VerificationEvidence[] = [];
  if (result.verificationDecision) {
    const decision = result.verificationDecision;
    evidence.push({
      status: "measured",
      kind: "runtime-output",
      detail: `Kernel verifier decision: ${decision.status}. Supporting evidence: ${decision.evidence.supporting}; contradictory evidence: ${decision.evidence.contradictory}.`,
    });
  }
  if (result.guardrailOutcome) {
    evidence.push({
      status: "measured",
      kind: "runtime-event",
      detail: `Execution guardrail triggered: ${result.guardrailOutcome.reason}.`,
    });
  }
  return evidence;
}

function safeExecutionReason(execution: TaskExecutionOptions | undefined): string | undefined {
  if (!execution) {
    return "No pre-authorized execution scope was supplied; the adapter will not grant authority.";
  }
  if (!execution.authority) {
    return "The live canary requires a pre-authorized execution scope; the adapter will not grant authority.";
  }
  if (execution.connectorCall) {
    return "Connector execution is outside the safe live-canary boundary.";
  }
  if (execution.kind && execution.kind !== "general") {
    return `Execution kind ${execution.kind} is outside the safe general-task boundary.`;
  }
  return undefined;
}

/**
 * Creates an opt-in live adapter around the minimal kernel. With no runtime it
 * returns honest pending/not-run observations and performs no process or
 * service access.
 */
export function createSafeLiveCanaryAdapter(
  options: SafeLiveCanaryAdapterOptions = {},
): CanaryAdapter {
  const allowedToolNames = new Set(options.allowedToolNames ?? ["discover_services"]);

  return {
    mode: "live-runtime",
    serial: true,
    async run(canary): Promise<CanaryObservation> {
      const runtime = options.runtimeForCanary?.(canary) ?? options.runtime;
      const execution = options.executionForCanary?.(canary) ?? options.execution;
      if (!runtime) {
        return {
          events: [],
          toolCallNames: [],
          skipped: {
            reason: "No safe live runtime was configured; no runtime was invoked.",
          },
        };
      }

      const executionReason = safeExecutionReason(execution);
      if (executionReason) {
        return {
          events: [],
          toolCallNames: [],
          skipped: { reason: executionReason },
        };
      }

      const events: string[] = [];
      const toolCallNames: string[] = [];
      const kernelEvents: KernelLifecycleEvent[] = [];
      const runtimeUsage: { value?: TokenUsage } = {};
      const runtimeAccountUsage: { value?: AccountUsage } = {};
      const turnCount = { value: 0 };
      let connectorDiscoveryBytes: number | undefined;
      let safetyViolation: string | undefined;

      const recordEvent = (name: string, bytes?: number) => {
        events.push(name);
        if (bytes !== undefined) connectorDiscoveryBytes = bytes;
        if (prohibitedEventNames.has(name)) safetyViolation = name;
      };
      const recordToolCall = (name: string, fingerprint?: string, failed?: boolean) => {
        toolCallNames.push(name);
        if (!allowedToolNames.has(name)) safetyViolation = `tool:${name}`;
        const budgetObserver = currentExecution?.budgetObserver;
        budgetObserver?.({
          type: "tool-started",
          fingerprint: fingerprint ?? `safe-canary:${name}`,
        });
        if (failed !== undefined) {
          budgetObserver?.({
            type: "tool-completed",
            fingerprint: fingerprint ?? `safe-canary:${name}`,
            failed,
          });
        }
      };
      let currentExecution: TaskExecutionOptions | undefined;
      let latestResult: SafeCanaryRuntimeResult | undefined;

      const worker: TaskExecutor = {
        async execute(
          _goal,
          signal,
          progress,
          usage,
          accountUsage,
          workerExecution,
        ): Promise<ExecutionResult> {
          currentExecution = workerExecution;
          const result = await runtime.run({
            canary,
            signal,
            progress,
            usage: (value) => {
              runtimeUsage.value = value;
              usage?.(value);
            },
            accountUsage: (value) => {
              runtimeAccountUsage.value = value;
              accountUsage?.(value);
            },
            turnStarted: () => {
              turnCount.value += 1;
              workerExecution?.budgetObserver?.({ type: "turn-started" });
            },
            toolCall: recordToolCall,
            event: recordEvent,
            execution: workerExecution,
          });
          latestResult = result;
          for (const event of result.events ?? []) {
            if (event.type === "tool-call") {
              recordToolCall(event.name, event.fingerprint, event.failed);
            } else {
              recordEvent(event.name, event.connectorDiscoveryBytes);
            }
          }
          for (const name of result.toolCallNames ?? []) {
            if (!toolCallNames.includes(name)) recordToolCall(name);
          }
          if (result.connectorDiscoveryBytes !== undefined) {
            connectorDiscoveryBytes = result.connectorDiscoveryBytes;
          }
          if (result.usage && !runtimeUsage.value) {
            runtimeUsage.value = result.usage;
            usage?.(result.usage);
          }
          return {
            summary: result.summary,
            verified: result.verified && !safetyViolation,
            reconciliationRequired: result.reconciliationRequired,
            verificationEvidence: result.verificationEvidence,
            usage: result.usage ?? runtimeUsage.value,
            accountUsage: result.accountUsage ?? runtimeAccountUsage.value,
            timing: result.timing,
            artifacts: result.artifacts,
          };
        },
      };

      const kernel = new MinimalExecutionKernel(worker, {
        selectConnectorCapabilities: options.selectConnectorCapabilities,
        verifier: options.verifier,
        now: options.now,
        budgets: options.budgets,
        onEvent: (event) => {
          kernelEvents.push(event);
          events.push(event.type);
        },
      });

      let result: ExecutionResult;
      try {
        result = await kernel.execute(
          canary.prompt,
          new AbortController().signal,
          () => {},
          (usage) => {
            runtimeUsage.value = usage;
          },
          (accountUsage) => {
            runtimeAccountUsage.value = accountUsage;
          },
          execution,
        );
      } catch (error) {
        return {
          events,
          toolCallNames,
          runtimeOutcome: "unverified",
          telemetry: {
            toolCalls: {
              status: "pending",
              unit: "count",
              note: "Tool-call count is unavailable because the live runtime did not settle.",
            },
          },
          verificationEvidence: [{
            status: "measured",
            kind: "runtime-event",
            detail: `The integrated kernel did not settle a live canary result (${error instanceof Error ? error.name : "unknown error"}).`,
          }],
        };
      }

      const outputText = latestResult?.outputText ?? result.summary;
      const telemetry = tokenTelemetry(result.usage ?? runtimeUsage.value);
      const timing = result.timing ?? latestResult?.timing;
      const verificationEvidence = [
        ...kernelEvidence(result),
        ...(latestResult?.verificationEvidence ?? []).map(() => ({
          status: "measured" as const,
          kind: "runtime-output" as const,
          detail: "Runtime-supplied verification evidence reached the kernel verifier.",
        })),
      ];
      if (safetyViolation) {
        verificationEvidence.push({
          status: "measured",
          kind: "runtime-event",
          detail: "The safe adapter rejected prohibited runtime activity.",
        });
      }

      return {
        outputText,
        events,
        toolCallNames,
        connectorDiscoveryBytes,
        runtimeOutcome: result.verified && !safetyViolation ? "verified" : "unverified",
        verificationEvidence,
        telemetry: {
          ...(telemetry ?? {}),
          ...(turnCount.value > 0
            ? { turns: measured(turnCount.value, "count") }
            : {}),
          toolCalls: measured(toolCallNames.length, "count"),
          ...(timing
            ? { latency: measured(timing.totalMs, "milliseconds") }
            : {}),
        },
      };
    },
  };
}
