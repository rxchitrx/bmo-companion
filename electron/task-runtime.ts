import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { diagnosticLog, textMeta } from "./diagnostics.js";
import type { ConnectorCall } from "./connector-types.js";
import type { TaskContextPacket } from "./context-packet.js";
import type { ExecutionCapabilityManifest } from "./execution-kernel.js";
import {
  allowTaskAuthority,
  askForTaskAuthority,
  createTaskAuthorityScope,
  denyTaskAuthority,
  evaluateTaskAuthority,
  pauseTaskAuthority,
  requireTaskAuthorityDecision,
  revalidateTaskAuthority,
  type ScopedTaskAuthority,
} from "./permission-lifecycle.js";
import type {
  VerificationDecision,
  VerificationEvidence,
} from "./outcome-verifier.js";

export type TaskKind = "general" | "coding" | "computer" | "browser" | "connector";

export type TaskStatus =
  | "waiting_approval"
  | "needs_decision"
  | "suspended"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface AccountUsage {
  planType?: string;
  primaryUsedPercent?: number;
  primaryResetsAt?: number;
  secondaryUsedPercent?: number;
  secondaryResetsAt?: number;
}

export interface TaskTiming {
  startupMs: number;
  executionMs: number;
  settlingMs: number;
  shutdownMs: number;
  totalMs: number;
}

export type ExecutionBudgetEvent =
  | { type: "usage"; totalTokens: number }
  | { type: "turn-started" }
  | { type: "tool-started"; fingerprint: string }
  | { type: "tool-completed"; fingerprint: string; failed: boolean };

export interface ExecutionGuardrailOutcome {
  version: 1;
  action: "stop" | "summarize" | "needs-decision";
  reason:
    | "tokens"
    | "time"
    | "tool-calls"
    | "turns"
    | "loop"
    | "repeated-failures";
  observed: number;
  limit: number;
  summary: string;
}

export interface TaskSnapshot {
  id: string;
  goal: string;
  status: TaskStatus;
  state: "idle" | "approval" | "thinking" | "working" | "speaking" | "error";
  summary?: string;
  progress: string[];
  approvalExpiresAt?: string;
  recoveryRequired?: boolean;
  directiveId?: string;
  usage?: TokenUsage;
  accountUsage?: AccountUsage;
  timing?: TaskTiming;
  kind?: TaskKind;
  model?: string;
  effort?: string;
  createdAt?: string;
  finishedAt?: string;
  retryOf?: string;
  priorOutcome?: string;
  connectorCall?: ConnectorCall;
  authority?: ScopedTaskAuthority;
}

export interface StoredTask {
  task: TaskSnapshot;
  approvalGrantedAt?: string;
  nextReminderAt?: string;
  reminderIndex: number;
  executionSurfaceAvailable: boolean;
}

export interface ExecutionResult {
  summary: string;
  verified: boolean;
  reconciliationRequired?: boolean;
  verificationEvidence?: VerificationEvidence[];
  verificationDecision?: VerificationDecision;
  usage?: TokenUsage;
  accountUsage?: AccountUsage;
  timing?: TaskTiming;
  artifacts?: Array<{ label: string; sourceName: string; sourceUrl?: string }>;
  guardrailOutcome?: ExecutionGuardrailOutcome;
}

export interface TaskExecutionOptions {
  model?: string;
  effort?: string;
  kind?: TaskKind;
  retryOf?: string;
  priorOutcome?: string;
  connectorCall?: ConnectorCall;
  contextPacket?: TaskContextPacket;
  capabilityManifest?: ExecutionCapabilityManifest;
  taskId?: string;
  authority?: ScopedTaskAuthority;
  budgetObserver?: (event: ExecutionBudgetEvent) => void;
}

export interface TaskExecutor {
  execute(
    goal: string,
    signal: AbortSignal,
    progress: (message: string) => void,
    usage?: (usage: TokenUsage) => void,
    accountUsage?: (usage: AccountUsage) => void,
    execution?: TaskExecutionOptions,
  ): Promise<ExecutionResult>;
}

export interface ActivityLedger { append(event: Record<string, unknown>): Promise<void>; }

export interface TaskStore {
  load(): Promise<StoredTask | null>;
  save(task: StoredTask | null): Promise<void>;
}

export interface RecoveryObserver {
  observe(task: TaskSnapshot): Promise<{ scopeStillMatches: boolean; detail?: string }>;
  reconcile?(task: TaskSnapshot): Promise<{
    goalSatisfied?: boolean;
    detail?: string;
  }>;
}

export interface DirectiveTracker {
  recordFailure(directiveId: string): Promise<{ suspended: boolean; consecutiveFailures: number }>;
}

export interface AttentionPolicy {
  laterReminderMinutes: number;
}

export interface CompletedTaskMemory {
  rememberCompletedTask(input: {
    taskId: string; goal: string; summary: string;
    artifacts?: Array<{ label: string; sourceName: string; sourceUrl?: string }>;
  }): Promise<unknown>;
}

export class JsonlActivityLedger implements ActivityLedger {
  constructor(private readonly path: string) {}
  async append(event: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
  }
}

/** A single encrypted-store slot in production; JSON is deliberately only the local prototype adapter. */
export class JsonTaskStore implements TaskStore {
  constructor(private readonly path: string) {}
  async load(): Promise<StoredTask | null> {
    try { return JSON.parse(await readFile(this.path, "utf8")) as StoredTask; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async save(task: StoredTask | null): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(task), "utf8");
  }
}

class NoopTaskStore implements TaskStore {
  async load() { return null; }
  async save(_task: StoredTask | null) {}
}

class RequiresOwnerDecisionObserver implements RecoveryObserver {
  async observe() {
    return { scopeStillMatches: false, detail: "No recovery observer is available to safely verify the current Mac state." };
  }
}

class NoopDirectiveTracker implements DirectiveTracker {
  async recordFailure() { return { suspended: false, consecutiveFailures: 0 }; }
}

const APPROVAL_MAX_MS = 2 * 60 * 60 * 1000;
const REMINDER_MINUTES = [2, 5, 10] as const;
const ACTIVE = new Set<TaskStatus>(["waiting_approval", "needs_decision", "suspended", "running"]);

/**
 * Owns the durable lifecycle of one Mac-control Task. Recovery is intentionally
 * a two-step operation: restore then observe/revalidate, never action replay.
 */
export class TaskRuntime {
  private current: StoredTask | null = null;
  private abortController: AbortController | null = null;
  private activeExecution: Promise<void> | null = null;

  constructor(
    private readonly executor: TaskExecutor,
    private readonly ledger: ActivityLedger,
    private readonly emit: (task: TaskSnapshot) => void,
    private readonly now: () => Date = () => new Date(),
    private readonly store: TaskStore = new NoopTaskStore(),
    private readonly observer: RecoveryObserver = new RequiresOwnerDecisionObserver(),
    private readonly directives: DirectiveTracker = new NoopDirectiveTracker(),
    private readonly attentionPolicy: AttentionPolicy = { laterReminderMinutes: 30 },
    private readonly memory?: CompletedTaskMemory,
  ) {}

  currentTask(): TaskSnapshot | null {
    return this.current ? this.snapshot() : null;
  }

  /** Restores context only. Call recover() before any external work can continue. */
  async restore(): Promise<TaskSnapshot | null> {
    diagnosticLog("task.runtime", "restore.requested");
    const stored = await this.store.load();
    if (!stored) {
      diagnosticLog("task.runtime", "restore.empty");
      return null;
    }
    diagnosticLog("task.runtime", "restore.loaded", {
      taskId: stored.task.id,
      status: stored.task.status,
      state: stored.task.state,
      progressCount: stored.task.progress.length,
      approvalExpiresAt: stored.task.approvalExpiresAt,
    });
    this.current = stored;
    this.ensureAuthority(stored);
    if (ACTIVE.has(stored.task.status)) {
      stored.task.status = "suspended";
      stored.task.state = "approval";
      stored.task.recoveryRequired = true;
      stored.task.summary = "Restart Recovery is checking the current state before this Task can continue.";
      stored.task.progress.push("Restart Recovery restored context. No prior Mac actions were replayed.");
      stored.task.authority = pauseTaskAuthority(
        stored.task.authority!,
        this.now(),
        "restart-recovery-required",
      );
      await this.persist("task.recovery_restored", { actionReplay: false });
    }
    this.publish();
    return this.snapshot();
  }

  async create(
    goal: string,
    options: {
      directiveId?: string;
      kind?: TaskKind;
      model?: string;
      effort?: string;
      retryOf?: string;
      priorOutcome?: string;
      connectorCall?: ConnectorCall;
    } = {},
  ): Promise<TaskSnapshot> {
    diagnosticLog("task.runtime", "create.requested", {
      goal: textMeta(goal),
      directiveId: options.directiveId,
      kind: options.kind,
      model: options.model,
      effort: options.effort,
      createdAt: this.now().toISOString(),
      retryOf: options.retryOf,
      priorOutcome: options.priorOutcome,
      connectorCall: options.connectorCall
        ? {
            service: options.connectorCall.service,
            action: options.connectorCall.action,
            mode: options.connectorCall.mode,
            argumentNames: Object.keys(options.connectorCall.arguments),
          }
        : undefined,
      currentTaskId: this.current?.task.id,
      currentStatus: this.current?.task.status,
    });
    if (this.current && ACTIVE.has(this.current.task.status)) {
      diagnosticLog("task.runtime", "create.blocked_active_task", {
        currentTaskId: this.current.task.id,
        currentStatus: this.current.task.status,
      });
      throw new Error("A Task is already active.");
    }
    const taskId = randomUUID();
    const task: TaskSnapshot = {
      id: taskId,
      goal,
      status: "waiting_approval",
      state: "approval",
      progress: ["Task created. Waiting for scoped approval."],
      directiveId: options.directiveId,
      kind: options.kind,
      model: options.model,
      effort: options.effort,
      createdAt: this.now().toISOString(),
      retryOf: options.retryOf,
      priorOutcome: options.priorOutcome,
      connectorCall: options.connectorCall,
      authority: askForTaskAuthority(
        createTaskAuthorityScope({
          taskId,
          goal,
          taskKind: options.kind,
          connectorCall: options.connectorCall,
        }),
        this.now(),
      ),
    };
    this.current = { task, reminderIndex: 0, nextReminderAt: this.afterMinutes(REMINDER_MINUTES[0]), executionSurfaceAvailable: true };
    await this.persist("task.created");
    this.publish();
    return this.snapshot();
  }

  async approve(id: string): Promise<void> {
    const stored = this.requireTask(id);
    diagnosticLog("task.runtime", "approve.requested", {
      taskId: id,
      status: stored.task.status,
    });
    if (stored.task.status !== "waiting_approval") throw new Error("Task is not awaiting approval.");
    this.grantApproval(stored);
    await this.persist("task.approved");
    this.publish();
    await this.startApprovedTask(stored);
  }

  async createRetry(
    previousId: string,
    goal: string,
    options: {
      kind?: "general" | "coding" | "computer" | "browser";
      model?: string;
      effort?: string;
    } = {},
  ): Promise<TaskSnapshot> {
    const previous = this.requireTask(previousId);
    if (["running", "waiting_approval", "suspended"].includes(previous.task.status)) {
      throw new Error("The current Task must settle before it can be retried.");
    }
    const priorOutcome =
      previous.task.summary ??
      previous.task.progress.at(-1) ??
      "The previous Task ended without a recorded outcome.";
    if (previous.task.status === "needs_decision") {
      this.ensureAuthority(previous);
      previous.task.authority = denyTaskAuthority(
        previous.task.authority!,
        this.now(),
        "superseded-by-explicit-retry",
      );
      previous.task.status = "cancelled";
      previous.task.state = "idle";
      previous.task.finishedAt = this.now().toISOString();
      previous.task.progress.push(
        "The owner explicitly requested a retry. This unresolved attempt was superseded without replay.",
      );
      await this.persist("task.superseded", {
        retryRequested: true,
        actionReplay: false,
      });
      this.publish();
    }
    return this.create(goal, {
      ...options,
      retryOf: previous.task.id,
      priorOutcome,
    });
  }

  /** Direct confirmation is required for every approval-window extension. */
  async extendApproval(id: string): Promise<void> {
    const stored = this.requireTask(id);
    diagnosticLog("task.runtime", "approval_extension.requested", {
      taskId: id,
      status: stored.task.status,
    });
    if (!["needs_decision", "suspended"].includes(stored.task.status)) throw new Error("Task approval cannot be extended in its current state.");
    this.grantApproval(stored);
    stored.task.status = "suspended";
    stored.task.state = "approval";
    stored.task.recoveryRequired = true;
    stored.task.progress.push("Approval extended by direct confirmation. Restart Recovery must still re-observe state.");
    stored.task.authority = pauseTaskAuthority(
      stored.task.authority!,
      this.now(),
      "recovery-revalidation-required",
    );
    await this.persist("task.approval_extended");
    this.publish();
  }

  /** Records a missing choice without treating it as a failure. */
  async needsDecision(id: string, question: string): Promise<void> {
    const stored = this.requireTask(id);
    diagnosticLog("task.runtime", "needs_decision.requested", {
      taskId: id,
      status: stored.task.status,
      question: textMeta(question),
    });
    if (!ACTIVE.has(stored.task.status)) return;
    stored.task.status = "needs_decision";
    stored.task.state = "approval";
    stored.task.summary = question;
    stored.task.progress.push(`Needs Decision: ${question}`);
    this.ensureAuthority(stored);
    stored.task.authority = requireTaskAuthorityDecision(
      stored.task.authority!,
      this.now(),
      "owner-decision-required",
    );
    stored.reminderIndex = 0;
    stored.nextReminderAt = this.afterMinutes(REMINDER_MINUTES[0]);
    this.abortController?.abort();
    await this.persist("task.needs_decision");
    this.publish();
  }

  /** Explicitly performs the required observation/revalidation gate after a restart or surface loss. */
  async recover(id: string): Promise<void> {
    const stored = this.requireTask(id);
    diagnosticLog("task.runtime", "recovery.requested", {
      taskId: id,
      status: stored.task.status,
      recoveryRequired: stored.task.recoveryRequired,
      executionSurfaceAvailable: stored.executionSurfaceAvailable,
      approvalExpiresAt: stored.task.approvalExpiresAt,
    });
    if (stored.task.status !== "suspended" || !stored.task.recoveryRequired) throw new Error("Task does not require Restart Recovery.");
    if (!stored.executionSurfaceAvailable) return;
    this.ensureAuthority(stored);
    const policy = evaluateTaskAuthority(
      stored.task.authority,
      this.authorityScope(stored.task),
      this.now(),
      { allowPaused: true },
    );
    if (policy.reason === "authority-expired") return this.expireApproval(stored);
    if (policy.decision !== "allow") {
      stored.task.status = "needs_decision";
      stored.task.state = "approval";
      stored.task.summary = `Task authority requires owner confirmation: ${policy.reason}.`;
      stored.task.progress.push(stored.task.summary);
      stored.task.authority = requireTaskAuthorityDecision(
        stored.task.authority!,
        this.now(),
        policy.reason,
      );
      await this.persist("task.recovery_requires_decision", {
        policyDecision: policy.decision,
        policyReason: policy.reason,
        actionReplay: false,
      });
      this.publish();
      return;
    }
    const observation = await this.observer.observe(this.snapshot());
    diagnosticLog("task.runtime", "recovery.observed", {
      taskId: id,
      scopeStillMatches: observation.scopeStillMatches,
      detail: observation.detail,
    });
    await this.record("task.recovery_observed", stored.task, { scopeStillMatches: observation.scopeStillMatches, detail: observation.detail });
    if (!observation.scopeStillMatches) {
      stored.task.status = "needs_decision";
      stored.task.state = "approval";
      stored.task.summary = observation.detail ?? "The current state changed and needs your decision.";
      stored.task.progress.push("Restart Recovery found changed external state. Waiting for your decision.");
      stored.task.authority = requireTaskAuthorityDecision(
        stored.task.authority!,
        this.now(),
        "external-scope-changed",
      );
      stored.reminderIndex = 0;
      stored.nextReminderAt = this.afterMinutes(REMINDER_MINUTES[0]);
      await this.persist("task.recovery_requires_decision", { actionReplay: false });
      this.publish();
      return;
    }
    stored.task.recoveryRequired = false;
    stored.task.status = "running";
    stored.task.state = "thinking";
    stored.task.progress.push("Restart Recovery re-observed state and revalidated authority.");
    stored.task.authority = revalidateTaskAuthority(stored.task.authority!, this.now());
    await this.persist("task.recovery_revalidated", { actionReplay: false });
    this.publish();
    await this.startApprovedTask(stored);
  }

  async setExecutionSurfaceAvailable(available: boolean): Promise<void> {
    diagnosticLog("task.runtime", "execution_surface.changed", {
      available,
      taskId: this.current?.task.id,
      status: this.current?.task.status,
    });
    if (!this.current || !ACTIVE.has(this.current.task.status)) return;
    this.current.executionSurfaceAvailable = available;
    if (!available) {
      this.current.task.status = "suspended";
      this.current.task.state = "approval";
      this.current.task.recoveryRequired = true;
      this.current.task.summary = "Mac-control is suspended while this Mac is locked or unavailable.";
      this.current.task.progress.push("Mac-control surface unavailable. Task suspended without replaying actions.");
      this.ensureAuthority(this.current);
      this.current.task.authority = pauseTaskAuthority(
        this.current.task.authority!,
        this.now(),
        "execution-surface-unavailable",
      );
      this.abortController?.abort();
      await this.persist("task.suspended", { reason: "execution_surface_unavailable" });
      this.publish();
      return;
    }
    this.current.task.progress.push("Mac-control surface is available. Restart Recovery is required before resuming.");
    await this.persist("task.surface_available");
    this.publish();
  }

  /** Invoked by the app's clock; deterministic callers can invoke it directly. */
  async sendDueReminders(): Promise<void> {
    diagnosticLog("task.runtime", "reminder.tick", {
      taskId: this.current?.task.id,
      status: this.current?.task.status,
      nextReminderAt: this.current?.nextReminderAt,
      reminderIndex: this.current?.reminderIndex,
    });
    if (!this.current) return;
    const stored = this.current;
    if (stored.approvalGrantedAt && this.approvalExpired(stored) && ACTIVE.has(stored.task.status)) {
      return this.expireApproval(stored);
    }
    if (!(["waiting_approval", "needs_decision"].includes(stored.task.status))) return;
    if (!stored.nextReminderAt || this.now().getTime() < Date.parse(stored.nextReminderAt)) return;
    stored.task.progress.push(`Reminder: this Task is awaiting ${stored.task.status === "waiting_approval" ? "approval" : "your decision"}.`);
    const interval = stored.reminderIndex === 0 ? 3
      : stored.reminderIndex === 1 ? 5
      : this.attentionPolicy.laterReminderMinutes;
    const cadenceMinutes = stored.reminderIndex < REMINDER_MINUTES.length
      ? REMINDER_MINUTES[stored.reminderIndex]
      : this.attentionPolicy.laterReminderMinutes;
    stored.reminderIndex += 1;
    stored.nextReminderAt = this.afterMinutes(interval);
    await this.persist("task.reminder", { cadenceMinutes, attentionPolicyAware: stored.reminderIndex > REMINDER_MINUTES.length });
    this.publish();
  }

  async deny(id: string): Promise<void> {
    diagnosticLog("task.runtime", "deny.requested", { taskId: id });
    await this.cancelWithReason(id, "approval_denied", "Task cancelled. Your Mac was not changed.");
  }
  async cancel(id: string): Promise<void> {
    diagnosticLog("task.runtime", "cancel.requested", { taskId: id });
    await this.cancelWithReason(id, "owner_stop", "Task stopped. Completed actions were not undone.");
  }
  async cancelActive(): Promise<boolean> {
    if (!this.current || !ACTIVE.has(this.current.task.status)) return false;
    await this.cancelWithReason(
      this.current.task.id,
      "owner_stop",
      "Task stopped. Completed actions were not undone.",
    );
    return true;
  }

  /** Explicit owner pause. Resume always goes through recover() and read-only revalidation. */
  async pause(id: string): Promise<void> {
    const stored = this.requireTask(id);
    if (stored.task.status !== "running") throw new Error("Only a running Task can be paused.");
    stored.task.status = "suspended";
    stored.task.state = "approval";
    stored.task.recoveryRequired = true;
    stored.task.summary = "Task paused. Mac-control authority is inactive until safe revalidation.";
    stored.task.progress.push(stored.task.summary);
    this.ensureAuthority(stored);
    stored.task.authority = pauseTaskAuthority(
      stored.task.authority!,
      this.now(),
      "owner-paused",
    );
    this.abortController?.abort();
    await this.persist("task.paused", { reason: "owner_pause" });
    this.publish();
  }

  async resume(id: string): Promise<void> {
    await this.recover(id);
  }

  private async cancelWithReason(id: string, reason: string, summary: string) {
    const stored = this.requireTask(id);
    if (!ACTIVE.has(stored.task.status)) {
      diagnosticLog("task.runtime", "cancel.ignored_inactive", {
        taskId: id,
        status: stored.task.status,
        reason,
      });
      return;
    }
    this.ensureAuthority(stored);
    stored.task.authority = denyTaskAuthority(
      stored.task.authority!,
      this.now(),
      reason,
    );
    stored.task.status = "cancelled"; stored.task.state = "idle"; stored.task.finishedAt = this.now().toISOString(); stored.task.summary = summary; stored.task.progress.push(summary);
    this.abortController?.abort();
    await this.persist("task.cancelled", { reason }); this.publish();
  }

  private async startApprovedTask(stored: StoredTask): Promise<void> {
    if (this.activeExecution) await this.activeExecution;
    const execution = this.runApprovedTask(stored);
    this.activeExecution = execution;
    try {
      await execution;
    } finally {
      if (this.activeExecution === execution) this.activeExecution = null;
    }
  }

  private async runApprovedTask(stored: StoredTask): Promise<void> {
    diagnosticLog("task.runtime", "execution.entered", {
      taskId: stored.task.id,
      status: stored.task.status,
      surfaceAvailable: stored.executionSurfaceAvailable,
      approvalValid: this.hasValidApproval(stored),
      policyDecision: this.permissionPolicy(stored).decision,
    });
    const policy = this.permissionPolicy(stored);
    if (this.current !== stored || !stored.executionSurfaceAvailable || policy.decision !== "allow") {
      if (this.current === stored && policy.reason === "authority-expired") await this.expireApproval(stored);
      return;
    }
    stored.task.status = "running"; stored.task.state = "thinking";
    this.abortController = new AbortController();
    await this.persist("task.running");
    try {
      const result = await this.executor.execute(
        stored.task.goal,
        this.abortController.signal,
        (message) => {
          if (this.current !== stored || stored.task.status !== "running") return;
          diagnosticLog("task.runtime", "execution.progress", {
            taskId: stored.task.id,
            message,
          });
          stored.task.state = "working"; stored.task.progress.push(message);
          void this.persist("task.progress", { message }); this.publish();
        },
        (usage) => {
          if (this.current !== stored || stored.task.status !== "running") return;
          stored.task.usage = usage;
          diagnosticLog("task.runtime", "execution.usage", {
            taskId: stored.task.id,
            usage,
          });
          void this.store.save(stored);
          this.publish();
        },
        (accountUsage) => {
          if (this.current !== stored || stored.task.status !== "running") return;
          stored.task.accountUsage = accountUsage;
          diagnosticLog("task.runtime", "execution.account_usage", {
            taskId: stored.task.id,
            accountUsage,
          });
          void this.store.save(stored);
          this.publish();
        },
          {
              taskId: stored.task.id,
              authority: structuredClone(stored.task.authority),
              model: stored.task.model,
              effort: stored.task.effort,
              kind: stored.task.kind,
              ...(stored.task.connectorCall
                ? { connectorCall: stored.task.connectorCall }
                : {}),
              ...(stored.task.retryOf
                ? { retryOf: stored.task.retryOf }
                : {}),
              ...(stored.task.priorOutcome
                ? { priorOutcome: stored.task.priorOutcome }
                : {}),
            },
      );
      if (this.current !== stored || stored.task.status !== "running") return;
      diagnosticLog("task.runtime", "execution.result", {
        taskId: stored.task.id,
        verified: result.verified,
        summary: result.summary,
        artifactCount: result.artifacts?.length ?? 0,
      });
      stored.task.summary = result.summary;
      if (result.usage) stored.task.usage = result.usage;
      if (result.accountUsage) stored.task.accountUsage = result.accountUsage;
      if (result.timing) stored.task.timing = result.timing;
      if (result.verified) {
        stored.task.authority = denyTaskAuthority(
          stored.task.authority!,
          this.now(),
          "task-settled",
        );
        stored.task.status = "completed"; stored.task.state = "speaking"; stored.task.finishedAt = this.now().toISOString(); stored.task.progress.push("Verified Outcome recorded.");
        await this.persist("task.completed", {
          verified: true,
          usage: stored.task.usage,
          accountUsage: stored.task.accountUsage,
          timing: stored.task.timing,
        });
        try {
          await this.memory?.rememberCompletedTask({
            taskId: stored.task.id,
            goal: stored.task.goal,
            summary: result.summary,
            artifacts: result.artifacts,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Memory write failed.";
          stored.task.progress.push("Task completed, but its memory candidate could not be saved.");
          await this.record("memory.write_failed", stored.task, { error: message });
        }
      } else if (result.reconciliationRequired) {
        await this.reconcileUnverified(stored);
      } else {
        await this.fail(
          stored,
          result.summary || "Codex finished without sufficient verification.",
          {
            verified: false,
            usage: stored.task.usage,
            accountUsage: stored.task.accountUsage,
            timing: stored.task.timing,
          },
        );
      }
    } catch (error) {
      diagnosticLog("task.runtime", "execution.error", {
        taskId: stored.task.id,
        aborted: this.abortController?.signal.aborted,
        currentMatches: this.current === stored,
        error: error instanceof Error ? error.message : String(error),
      });
      if (this.current !== stored || this.abortController?.signal.aborted) return;
      await this.fail(stored, error instanceof Error ? error.message : "Task execution failed.");
    } finally {
      diagnosticLog("task.runtime", "execution.finally", {
        taskId: stored.task.id,
        status: stored.task.status,
        state: stored.task.state,
      });
      if (this.current === stored) { this.abortController = null; this.publish(); }
    }
  }

  private async fail(stored: StoredTask, summary: string, extra: Record<string, unknown> = {}) {
    if (/computer use session was stopped|readline was closed|timed out waiting for tools\/call/i.test(summary)) {
      summary =
        "UNVERIFIED: Computer Use lost its session before it could verify the result. The Mac may already have changed. BMO will not retry automatically.";
    }
    diagnosticLog("task.runtime", "failed", {
      taskId: stored.task.id,
      summary,
      extra,
    });
    this.ensureAuthority(stored);
    stored.task.authority = denyTaskAuthority(
      stored.task.authority!,
      this.now(),
      "task-settled",
    );
    stored.task.status = "failed"; stored.task.state = "error"; stored.task.finishedAt = this.now().toISOString(); stored.task.summary = summary; stored.task.progress.push(summary);
    await this.persist("task.failed", extra);
    if (stored.task.directiveId) {
      const outcome = await this.directives.recordFailure(stored.task.directiveId);
      await this.record(outcome.suspended ? "directive.suspended" : "directive.failure", stored.task, { directiveId: stored.task.directiveId, ...outcome });
      if (outcome.suspended) stored.task.progress.push("Standing Directive paused after repeated failed or blocked Tasks.");
    }
  }

  private async reconcileUnverified(stored: StoredTask) {
    stored.task.status = "running";
    stored.task.state = "thinking";
    stored.task.summary =
      "Computer Use lost its session after the Mac may have changed. Reconciling the actual state without retrying.";
    stored.task.progress.push(
      "Computer Use session quarantined. Starting read-only state reconciliation.",
    );
    await this.persist("task.reconciling", {
      actionReplay: false,
      usage: stored.task.usage,
      accountUsage: stored.task.accountUsage,
      timing: stored.task.timing,
    });
    this.publish();

    let observation: { goalSatisfied?: boolean; detail?: string };
    try {
      observation = this.observer.reconcile
        ? await this.observer.reconcile(this.snapshot())
        : {
            goalSatisfied: undefined,
            detail: (await this.observer.observe(this.snapshot())).detail,
          };
    } catch (error) {
      observation = {
        goalSatisfied: undefined,
        detail:
          error instanceof Error
            ? error.message
            : "State reconciliation failed.",
      };
    }
    if (this.current !== stored || stored.task.status !== "running") return;

    const detail =
      observation.detail ??
      "BMO could not directly determine the final Mac state.";
    await this.record("task.reconciliation_observed", stored.task, {
      goalSatisfied: observation.goalSatisfied,
      detail,
      actionReplay: false,
    });
    if (observation.goalSatisfied === true) {
      this.ensureAuthority(stored);
      stored.task.authority = denyTaskAuthority(
        stored.task.authority!,
        this.now(),
        "task-settled",
      );
      stored.task.status = "completed";
      stored.task.state = "speaking";
      stored.task.finishedAt = this.now().toISOString();
      stored.task.summary = `VERIFIED OUTCOME AFTER RECONCILIATION: ${detail}`;
      stored.task.progress.push(
        "Read-only reconciliation verified that the original goal is already satisfied.",
      );
      await this.persist("task.completed", {
        verified: true,
        reconciled: true,
        actionReplay: false,
        usage: stored.task.usage,
        accountUsage: stored.task.accountUsage,
        timing: stored.task.timing,
      });
      return;
    }

    stored.task.status = "needs_decision";
    stored.task.state = "approval";
    stored.task.recoveryRequired = false;
    stored.task.summary =
      `RECONCILIATION: ${detail} No action was replayed and BMO will not retry automatically.`;
    stored.task.progress.push(
      "Reconciliation could not verify completion. Waiting for the owner instead of retrying.",
    );
    this.ensureAuthority(stored);
    stored.task.authority = requireTaskAuthorityDecision(
      stored.task.authority!,
      this.now(),
      "reconciliation-owner-decision-required",
    );
    stored.reminderIndex = 0;
    stored.nextReminderAt = this.afterMinutes(REMINDER_MINUTES[0]);
    await this.persist("task.reconciliation_requires_decision", {
      goalSatisfied: observation.goalSatisfied,
      actionReplay: false,
      usage: stored.task.usage,
      accountUsage: stored.task.accountUsage,
      timing: stored.task.timing,
    });
  }

  private grantApproval(stored: StoredTask) {
    const granted = this.now();
    stored.approvalGrantedAt = granted.toISOString();
    stored.task.approvalExpiresAt = new Date(granted.getTime() + APPROVAL_MAX_MS).toISOString();
    stored.task.authority = allowTaskAuthority(
      this.authorityScope(stored.task),
      granted,
      new Date(stored.task.approvalExpiresAt),
    );
    stored.reminderIndex = 0; stored.nextReminderAt = undefined;
    stored.task.status = "running"; stored.task.state = "thinking"; stored.task.recoveryRequired = false;
    stored.task.progress.push(
      stored.task.kind === "connector"
        ? "Approved for this Task. Preparing the connected-service action."
        : "Approved for this Task. Preparing Codex.",
    );
    diagnosticLog("task.runtime", "approval.granted", {
      taskId: stored.task.id,
      approvalGrantedAt: stored.approvalGrantedAt,
      approvalExpiresAt: stored.task.approvalExpiresAt,
      policyDecision: stored.task.authority.decision,
      authorityScope: stored.task.authority.scope,
    });
  }
  private authorityScope(task: TaskSnapshot) {
    return createTaskAuthorityScope({
      taskId: task.id,
      goal: task.goal,
      taskKind: task.kind,
      connectorCall: task.connectorCall,
    });
  }
  private ensureAuthority(stored: StoredTask) {
    if (stored.task.authority) return;
    const scope = this.authorityScope(stored.task);
    const expiresAt = stored.task.approvalExpiresAt;
    const canRestorePriorAllow =
      expiresAt && ["running", "suspended"].includes(stored.task.status);
    const restored = canRestorePriorAllow
      ? allowTaskAuthority(
          scope,
          new Date(stored.approvalGrantedAt ?? stored.task.createdAt ?? this.now()),
          new Date(expiresAt),
          "legacy-approval-restored",
        )
      : askForTaskAuthority(scope, this.now());
    stored.task.authority = ACTIVE.has(stored.task.status)
      ? restored
      : denyTaskAuthority(restored, this.now(), "task-settled");
  }
  private permissionPolicy(stored: StoredTask) {
    this.ensureAuthority(stored);
    return evaluateTaskAuthority(
      stored.task.authority,
      this.authorityScope(stored.task),
      this.now(),
    );
  }
  private hasValidApproval(stored: StoredTask) {
    return this.permissionPolicy(stored).decision === "allow";
  }
  private approvalExpired(stored: StoredTask) {
    return !stored.task.approvalExpiresAt ||
      this.now().getTime() >= Date.parse(stored.task.approvalExpiresAt);
  }
  private async expireApproval(stored: StoredTask) {
    diagnosticLog("task.runtime", "approval.expired", {
      taskId: stored.task.id,
      approvalExpiresAt: stored.task.approvalExpiresAt,
    });
    stored.task.status = "needs_decision"; stored.task.state = "approval"; stored.task.recoveryRequired = true;
    this.ensureAuthority(stored);
    stored.task.authority = requireTaskAuthorityDecision(
      stored.task.authority!,
      this.now(),
      "authority-expired",
      "expired",
    );
    stored.task.summary = "Task Approval expired after two hours. Direct confirmation is required to continue.";
    stored.task.progress.push(stored.task.summary); stored.nextReminderAt = undefined;
    this.abortController?.abort();
    await this.persist("task.approval_expired"); this.publish();
  }
  private afterMinutes(minutes: number) { return new Date(this.now().getTime() + minutes * 60_000).toISOString(); }
  private requireTask(id: string) { if (!this.current || this.current.task.id !== id) throw new Error("Task was not found."); return this.current; }
  private snapshot() { if (!this.current) throw new Error("Task was not found."); return structuredClone(this.current.task); }
  private publish() {
    if (!this.current) return;
    diagnosticLog("task.runtime", "state.published", {
      taskId: this.current.task.id,
      status: this.current.task.status,
      state: this.current.task.state,
      progressCount: this.current.task.progress.length,
      summary: this.current.task.summary,
    });
    this.emit(this.snapshot());
  }
  private async persist(type: string, extra: Record<string, unknown> = {}) {
    if (!this.current) return;
    diagnosticLog("task.runtime", "state.persist.started", {
      ledgerType: type,
      taskId: this.current.task.id,
      status: this.current.task.status,
      extra,
    });
    await this.store.save(this.current);
    await this.record(type, this.current.task, extra);
    diagnosticLog("task.runtime", "state.persist.completed", {
      ledgerType: type,
      taskId: this.current.task.id,
    });
  }
  private record(type: string, task: TaskSnapshot, extra: Record<string, unknown> = {}) {
    diagnosticLog("task.runtime", "ledger.append", {
      ledgerType: type,
      taskId: task.id,
      status: task.status,
      extra,
    });
    return this.ledger.append({ type, at: this.now().toISOString(), taskId: task.id, goal: task.goal, status: task.status, ...extra });
  }
}
