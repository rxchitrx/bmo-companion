export type CompanionState =
  | "idle"
  | "listening"
  | "approval"
  | "thinking"
  | "working"
  | "speaking"
  | "error";

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
  state: CompanionState;
  summary?: string;
  progress: string[];
}

export interface CompanionApi {
  startTask(goal: string): Promise<TaskSnapshot>;
  approveTask(taskId: string): Promise<void>;
  denyTask(taskId: string): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  onTaskUpdate(listener: (task: TaskSnapshot) => void): () => void;
}
