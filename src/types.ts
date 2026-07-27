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
  sendConversation(text: string): Promise<ConversationUpdate>;
  startRealtimeVoice(offerSdp: string): Promise<RealtimeVoiceStartResult>;
  stopRealtimeVoice(): Promise<void>;
  startTask(goal: string): Promise<TaskSnapshot>;
  approveTask(taskId: string): Promise<void>;
  extendTaskApproval(taskId: string): Promise<void>;
  recoverTask(taskId: string): Promise<void>;
  denyTask(taskId: string): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  recallMemory(question: string): Promise<RecallAnswer>;
  logDiagnostic(event: ClientDiagnosticEvent): void;
  onConversationUpdate(listener: (update: ConversationUpdate) => void): () => void;
  onRealtimeVoiceUpdate(listener: (update: RealtimeVoiceUpdate) => void): () => void;
  onTaskUpdate(listener: (task: TaskSnapshot) => void): () => void;
}

export type RealtimeVoiceStatus =
  | "connecting"
  | "connected"
  | "listening"
  | "thinking"
  | "speaking"
  | "closed"
  | "failed";

export interface RealtimeVoiceUpdate {
  sessionId: string;
  status: RealtimeVoiceStatus;
  role?: "user" | "assistant";
  transcript?: string;
  error?: string;
  reason?: string;
}

export interface RealtimeVoiceStartResult {
  sessionId: string;
  answerSdp: string;
}

export type ConversationStatus =
  | "connecting"
  | "sending"
  | "responding"
  | "completed"
  | "degraded"
  | "failed";

export interface ConversationUpdate {
  requestId: string;
  status: ConversationStatus;
  transport: "realtime" | "codex-turn";
  assistantText?: string;
  warning?: string;
  error?: string;
}

export interface ClientDiagnosticEvent {
  at: string;
  scope: string;
  event: string;
  details: unknown;
}

export interface RecallAnswer {
  answer: string;
  references: Array<{ taskId: string; ledgerReference: string; source?: { label: string; sourceName: string; sourceUrl?: string } }>;
}
