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
  state: CompanionState;
  summary?: string;
  progress: string[];
  approvalExpiresAt?: string;
  recoveryRequired?: boolean;
  directiveId?: string;
}

export interface CompanionApi {
  startTask(goal: string): Promise<TaskSnapshot>;
  approveTask(taskId: string): Promise<void>;
  extendTaskApproval(taskId: string): Promise<void>;
  recoverTask(taskId: string): Promise<void>;
  denyTask(taskId: string): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  recallMemory(question: string): Promise<RecallAnswer>;
  onTaskUpdate(listener: (task: TaskSnapshot) => void): () => void;
}

export interface RecallAnswer {
  answer: string;
  references: Array<{ taskId: string; ledgerReference: string; source?: { label: string; sourceName: string; sourceUrl?: string } }>;
}
