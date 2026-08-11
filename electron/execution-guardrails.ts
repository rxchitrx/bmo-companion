import type {
  ExecutionBudgetEvent,
  ExecutionGuardrailOutcome,
} from "./task-runtime.js";

export const EXECUTION_GUARDRAIL_VERSION = 1 as const;

export interface ExecutionBudgets {
  maxTotalTokens: number;
  maxDurationMs: number;
  maxToolCalls: number;
  maxTurns: number;
  maxRepeatedActionOccurrences: number;
  maxRepeatedFailures: number;
}

export const DEFAULT_EXECUTION_BUDGETS: Readonly<ExecutionBudgets> = {
  maxTotalTokens: 250_000,
  maxDurationMs: 5 * 60_000,
  maxToolCalls: 32,
  maxTurns: 4,
  maxRepeatedActionOccurrences: 3,
  maxRepeatedFailures: 3,
};

export interface ExecutionBudgetSnapshot {
  totalTokens: number;
  toolCalls: number;
  turns: number;
  repeatedActionOccurrences: number;
  repeatedFailures: number;
}

function boundedInteger(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

export function resolveExecutionBudgets(
  values: Partial<ExecutionBudgets> = {},
): ExecutionBudgets {
  return {
    maxTotalTokens: boundedInteger(
      values.maxTotalTokens,
      DEFAULT_EXECUTION_BUDGETS.maxTotalTokens,
    ),
    maxDurationMs: boundedInteger(
      values.maxDurationMs,
      DEFAULT_EXECUTION_BUDGETS.maxDurationMs,
    ),
    maxToolCalls: boundedInteger(
      values.maxToolCalls,
      DEFAULT_EXECUTION_BUDGETS.maxToolCalls,
    ),
    maxTurns: boundedInteger(values.maxTurns, DEFAULT_EXECUTION_BUDGETS.maxTurns),
    maxRepeatedActionOccurrences: boundedInteger(
      values.maxRepeatedActionOccurrences,
      DEFAULT_EXECUTION_BUDGETS.maxRepeatedActionOccurrences,
    ),
    maxRepeatedFailures: boundedInteger(
      values.maxRepeatedFailures,
      DEFAULT_EXECUTION_BUDGETS.maxRepeatedFailures,
    ),
  };
}

function summaryFor(
  action: ExecutionGuardrailOutcome["action"],
  reason: ExecutionGuardrailOutcome["reason"],
  observed: number,
  limit: number,
) {
  if (action === "summarize") {
    return `BUDGET SUMMARY: Total token use reached ${observed} against a limit of ${limit}. Work stopped; review the current Task evidence before continuing.`;
  }
  if (action === "stop") {
    return `BUDGET STOP: Execution time reached the ${limit} ms limit. Work stopped without another attempt.`;
  }
  const labels: Record<Exclude<ExecutionGuardrailOutcome["reason"], "tokens" | "time">, string> = {
    "tool-calls": "tool-call budget",
    turns: "turn budget",
    loop: "repeated-action limit",
    "repeated-failures": "repeated-failure limit",
  };
  return `NEEDS DECISION: The ${labels[reason as keyof typeof labels]} was reached (${observed}/${limit}). BMO stopped before another attempt.`;
}

/** Tracks counters and structural fingerprints only; it never retains raw Task content. */
export class ExecutionGuardrailTracker {
  readonly budgets: ExecutionBudgets;
  private totalTokens = 0;
  private toolCalls = 0;
  private turns = 0;
  private lastActionFingerprint: string | undefined;
  private repeatedActionOccurrences = 0;
  private lastFailureFingerprint: string | undefined;
  private repeatedFailures = 0;
  private outcome: ExecutionGuardrailOutcome | undefined;

  constructor(values: Partial<ExecutionBudgets> = {}) {
    this.budgets = resolveExecutionBudgets(values);
  }

  observe(event: ExecutionBudgetEvent): ExecutionGuardrailOutcome | undefined {
    if (this.outcome) return this.outcome;
    if (event.type === "usage") {
      this.totalTokens = Math.max(this.totalTokens, event.totalTokens);
      if (this.totalTokens > this.budgets.maxTotalTokens) {
        return this.stop("summarize", "tokens", this.totalTokens, this.budgets.maxTotalTokens);
      }
    } else if (event.type === "turn-started") {
      this.turns += 1;
      if (this.turns > this.budgets.maxTurns) {
        return this.stop("needs-decision", "turns", this.turns, this.budgets.maxTurns);
      }
    } else if (event.type === "tool-started") {
      this.toolCalls += 1;
      if (event.fingerprint === this.lastActionFingerprint) {
        this.repeatedActionOccurrences += 1;
      } else {
        this.lastActionFingerprint = event.fingerprint;
        this.repeatedActionOccurrences = 1;
      }
      if (this.toolCalls > this.budgets.maxToolCalls) {
        return this.stop("needs-decision", "tool-calls", this.toolCalls, this.budgets.maxToolCalls);
      }
      if (
        this.repeatedActionOccurrences >=
        this.budgets.maxRepeatedActionOccurrences
      ) {
        return this.stop(
          "needs-decision",
          "loop",
          this.repeatedActionOccurrences,
          this.budgets.maxRepeatedActionOccurrences,
        );
      }
    } else if (event.type === "tool-completed") {
      if (!event.failed) {
        this.lastFailureFingerprint = undefined;
        this.repeatedFailures = 0;
      } else if (event.fingerprint === this.lastFailureFingerprint) {
        this.repeatedFailures += 1;
      } else {
        this.lastFailureFingerprint = event.fingerprint;
        this.repeatedFailures = 1;
      }
      if (this.repeatedFailures >= this.budgets.maxRepeatedFailures) {
        return this.stop(
          "needs-decision",
          "repeated-failures",
          this.repeatedFailures,
          this.budgets.maxRepeatedFailures,
        );
      }
    }
    return undefined;
  }

  expireTime(): ExecutionGuardrailOutcome {
    return this.outcome ?? this.stop(
      "stop",
      "time",
      this.budgets.maxDurationMs,
      this.budgets.maxDurationMs,
    );
  }

  snapshot(): ExecutionBudgetSnapshot {
    return {
      totalTokens: this.totalTokens,
      toolCalls: this.toolCalls,
      turns: this.turns,
      repeatedActionOccurrences: this.repeatedActionOccurrences,
      repeatedFailures: this.repeatedFailures,
    };
  }

  private stop(
    action: ExecutionGuardrailOutcome["action"],
    reason: ExecutionGuardrailOutcome["reason"],
    observed: number,
    limit: number,
  ): ExecutionGuardrailOutcome {
    this.outcome = {
      version: EXECUTION_GUARDRAIL_VERSION,
      action,
      reason,
      observed,
      limit,
      summary: summaryFor(action, reason, observed, limit),
    };
    return this.outcome;
  }
}
