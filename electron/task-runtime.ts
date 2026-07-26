import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type TaskStatus =
  | "waiting_approval"
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
}

export interface ExecutionResult {
  summary: string;
  verified: boolean;
}

export interface TaskExecutor {
  execute(
    goal: string,
    signal: AbortSignal,
    progress: (message: string) => void,
  ): Promise<ExecutionResult>;
}

export interface ActivityLedger {
  append(event: Record<string, unknown>): Promise<void>;
}

export class JsonlActivityLedger implements ActivityLedger {
  constructor(private readonly path: string) {}

  async append(event: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
  }
}

export class TaskRuntime {
  private current: TaskSnapshot | null = null;
  private abortController: AbortController | null = null;

  constructor(
    private readonly executor: TaskExecutor,
    private readonly ledger: ActivityLedger,
    private readonly emit: (task: TaskSnapshot) => void,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async create(goal: string): Promise<TaskSnapshot> {
    if (this.current && ["waiting_approval", "running"].includes(this.current.status)) {
      throw new Error("A Mac-control Task is already active.");
    }
    const task: TaskSnapshot = {
      id: randomUUID(),
      goal,
      status: "waiting_approval",
      state: "approval",
      progress: ["Task created. Waiting for scoped approval."],
    };
    this.current = task;
    await this.record("task.created", task);
    this.publish();
    return structuredClone(task);
  }

  async approve(id: string): Promise<void> {
    const task = this.requireTask(id);
    if (task.status !== "waiting_approval") throw new Error("Task is not awaiting approval.");
    task.status = "running";
    task.state = "thinking";
    task.progress.push("Approved for this Task. Preparing Codex.");
    await this.record("task.approved", task);
    this.publish();

    this.abortController = new AbortController();
    try {
      const result = await this.executor.execute(
        task.goal,
        this.abortController.signal,
        (message) => {
          task.state = "working";
          task.progress.push(message);
          void this.record("task.progress", task, { message });
          this.publish();
        },
      );
      task.summary = result.summary;
      if (result.verified) {
        task.status = "completed";
        task.state = "speaking";
        task.progress.push("Verified Outcome recorded.");
        await this.record("task.completed", task, { verified: true });
      } else {
        task.status = "failed";
        task.state = "error";
        task.progress.push("Codex finished without sufficient verification.");
        await this.record("task.failed", task, { verified: false });
      }
    } catch (error) {
      if (this.abortController.signal.aborted) return;
      task.status = "failed";
      task.state = "error";
      task.summary = error instanceof Error ? error.message : "Task execution failed.";
      task.progress.push(task.summary);
      await this.record("task.failed", task, { error: task.summary });
    } finally {
      this.abortController = null;
      this.publish();
    }
  }

  async deny(id: string): Promise<void> {
    const task = this.requireTask(id);
    if (task.status !== "waiting_approval") return;
    task.status = "cancelled";
    task.state = "idle";
    task.summary = "Task cancelled. Your Mac was not changed.";
    task.progress.push(task.summary);
    await this.record("task.cancelled", task, { reason: "approval_denied" });
    this.publish();
  }

  async cancel(id: string): Promise<void> {
    const task = this.requireTask(id);
    if (!["waiting_approval", "running"].includes(task.status)) return;
    this.abortController?.abort();
    task.status = "cancelled";
    task.state = "idle";
    task.summary = "Task stopped. Completed actions were not undone.";
    task.progress.push(task.summary);
    await this.record("task.cancelled", task, { reason: "owner_stop" });
    this.publish();
  }

  private requireTask(id: string): TaskSnapshot {
    if (!this.current || this.current.id !== id) throw new Error("Task was not found.");
    return this.current;
  }

  private publish() {
    if (this.current) this.emit(structuredClone(this.current));
  }

  private record(type: string, task: TaskSnapshot, extra: Record<string, unknown> = {}) {
    return this.ledger.append({
      type,
      at: this.now(),
      taskId: task.id,
      goal: task.goal,
      status: task.status,
      ...extra,
    });
  }
}
