import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { diagnosticLog, textMeta } from "./diagnostics.js";

export type TaskStatus =
  | "waiting_approval"
  | "needs_decision"
  | "suspended"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

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
  artifacts?: Array<{ label: string; sourceName: string; sourceUrl?: string }>;
}

export interface TaskExecutor {
  execute(goal: string, signal: AbortSignal, progress: (message: string) => void): Promise<ExecutionResult>;
}

export interface ActivityLedger { append(event: Record<string, unknown>): Promise<void>; }

export interface TaskStore {
  load(): Promise<StoredTask | null>;
  save(task: StoredTask | null): Promise<void>;
}

export interface RecoveryObserver {
  observe(task: TaskSnapshot): Promise<{ scopeStillMatches: boolean; detail?: string }>;
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
    if (ACTIVE.has(stored.task.status)) {
      stored.task.status = "suspended";
      stored.task.state = "approval";
      stored.task.recoveryRequired = true;
      stored.task.summary = "Restart Recovery is checking the current state before this Task can continue.";
      stored.task.progress.push("Restart Recovery restored context. No prior Mac actions were replayed.");
      await this.persist("task.recovery_restored", { actionReplay: false });
    }
    this.publish();
    return this.snapshot();
  }

  async create(goal: string, options: { directiveId?: string } = {}): Promise<TaskSnapshot> {
    diagnosticLog("task.runtime", "create.requested", {
      goal: textMeta(goal),
      directiveId: options.directiveId,
      currentTaskId: this.current?.task.id,
      currentStatus: this.current?.task.status,
    });
    if (this.current && ACTIVE.has(this.current.task.status)) {
      diagnosticLog("task.runtime", "create.blocked_active_task", {
        currentTaskId: this.current.task.id,
        currentStatus: this.current.task.status,
      });
      throw new Error("A Mac-control Task is already active.");
    }
    const task: TaskSnapshot = {
      id: randomUUID(), goal, status: "waiting_approval", state: "approval", progress: ["Task created. Waiting for scoped approval."], directiveId: options.directiveId,
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
    await this.runApprovedTask(stored);
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
    this.abortController?.abort();
    stored.task.status = "needs_decision";
    stored.task.state = "approval";
    stored.task.summary = question;
    stored.task.progress.push(`Needs Decision: ${question}`);
    stored.reminderIndex = 0;
    stored.nextReminderAt = this.afterMinutes(REMINDER_MINUTES[0]);
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
    if (!this.hasValidApproval(stored)) return this.expireApproval(stored);
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
    await this.persist("task.recovery_revalidated", { actionReplay: false });
    this.publish();
    await this.runApprovedTask(stored);
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
      this.abortController?.abort();
      this.current.task.status = "suspended";
      this.current.task.state = "approval";
      this.current.task.recoveryRequired = true;
      this.current.task.summary = "Mac-control is suspended while this Mac is locked or unavailable.";
      this.current.task.progress.push("Mac-control surface unavailable. Task suspended without replaying actions.");
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
    if (stored.approvalGrantedAt && !this.hasValidApproval(stored) && ACTIVE.has(stored.task.status)) {
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
    this.abortController?.abort();
    stored.task.status = "cancelled"; stored.task.state = "idle"; stored.task.summary = summary; stored.task.progress.push(summary);
    await this.persist("task.cancelled", { reason }); this.publish();
  }

  private async runApprovedTask(stored: StoredTask): Promise<void> {
    diagnosticLog("task.runtime", "execution.entered", {
      taskId: stored.task.id,
      status: stored.task.status,
      surfaceAvailable: stored.executionSurfaceAvailable,
      approvalValid: this.hasValidApproval(stored),
    });
    if (this.current !== stored || !stored.executionSurfaceAvailable || !this.hasValidApproval(stored)) {
      if (this.current === stored && !this.hasValidApproval(stored)) await this.expireApproval(stored);
      return;
    }
    stored.task.status = "running"; stored.task.state = "thinking";
    this.abortController = new AbortController();
    await this.persist("task.running");
    try {
      const result = await this.executor.execute(stored.task.goal, this.abortController.signal, (message) => {
        if (this.current !== stored || stored.task.status !== "running") return;
        diagnosticLog("task.runtime", "execution.progress", {
          taskId: stored.task.id,
          message,
        });
        stored.task.state = "working"; stored.task.progress.push(message);
        void this.persist("task.progress", { message }); this.publish();
      });
      if (this.current !== stored || stored.task.status !== "running") return;
      diagnosticLog("task.runtime", "execution.result", {
        taskId: stored.task.id,
        verified: result.verified,
        summary: result.summary,
        artifactCount: result.artifacts?.length ?? 0,
      });
      stored.task.summary = result.summary;
      if (result.verified) {
        stored.task.status = "completed"; stored.task.state = "speaking"; stored.task.progress.push("Verified Outcome recorded.");
        await this.persist("task.completed", { verified: true });
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
      } else await this.fail(stored, "Codex finished without sufficient verification.", { verified: false });
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
    diagnosticLog("task.runtime", "failed", {
      taskId: stored.task.id,
      summary,
      extra,
    });
    stored.task.status = "failed"; stored.task.state = "error"; stored.task.summary = summary; stored.task.progress.push(summary);
    await this.persist("task.failed", extra);
    if (stored.task.directiveId) {
      const outcome = await this.directives.recordFailure(stored.task.directiveId);
      await this.record(outcome.suspended ? "directive.suspended" : "directive.failure", stored.task, { directiveId: stored.task.directiveId, ...outcome });
      if (outcome.suspended) stored.task.progress.push("Standing Directive paused after repeated failed or blocked Tasks.");
    }
  }

  private grantApproval(stored: StoredTask) {
    const granted = this.now();
    stored.approvalGrantedAt = granted.toISOString();
    stored.task.approvalExpiresAt = new Date(granted.getTime() + APPROVAL_MAX_MS).toISOString();
    stored.reminderIndex = 0; stored.nextReminderAt = undefined;
    stored.task.status = "running"; stored.task.state = "thinking"; stored.task.recoveryRequired = false;
    stored.task.progress.push("Approved for this Task. Preparing Codex.");
    diagnosticLog("task.runtime", "approval.granted", {
      taskId: stored.task.id,
      approvalGrantedAt: stored.approvalGrantedAt,
      approvalExpiresAt: stored.task.approvalExpiresAt,
    });
  }
  private hasValidApproval(stored: StoredTask) { return !!stored.task.approvalExpiresAt && this.now().getTime() < Date.parse(stored.task.approvalExpiresAt); }
  private async expireApproval(stored: StoredTask) {
    diagnosticLog("task.runtime", "approval.expired", {
      taskId: stored.task.id,
      approvalExpiresAt: stored.task.approvalExpiresAt,
    });
    this.abortController?.abort();
    stored.task.status = "needs_decision"; stored.task.state = "approval"; stored.task.recoveryRequired = true;
    stored.task.summary = "Task Approval expired after two hours. Direct confirmation is required to continue.";
    stored.task.progress.push(stored.task.summary); stored.nextReminderAt = undefined;
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
