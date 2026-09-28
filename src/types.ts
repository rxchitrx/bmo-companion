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
  project?: CodeProjectRef;
  codeReview?: { digest: string; changed: string[]; verification?: { label: string; exitCode: number | null; output: string; passed: boolean } };
  connectorCall?: {
    service: string;
    action: string;
    arguments: Record<string, string | number | boolean>;
    mode: "read" | "write";
    label: string;
  };
}

export type TaskKind = "general" | "coding" | "computer" | "browser" | "connector";
export type VerificationPreset = "npm-test" | "python-unittest" | "pytest";
export interface SavedProject { id: string; name: string; aliases: string[]; root: string; verification: VerificationPreset; }
export interface CodeProjectRef extends SavedProject { baseCommit: string; }
export interface ProjectList { projects: SavedProject[]; activeId?: string; }
export interface CodeReview { taskId: string; projectName: string; root: string; workspace: string; changed: string[]; diff: string; verified: boolean; verification?: { label: string; exitCode: number | null; output: string; passed: boolean }; state?: "applying" | "applied" | "discarding" | "discarded"; }
export interface CodeReviewEntry { id: string; projectName: string; summary?: string; status: TaskStatus; state?: "applying" | "applied" | "discarding" | "discarded"; }
export interface ConnectorActionSummary {
  name: string;
  label: string;
  description: string;
  mode: "read" | "write";
  parameters: Array<{
    name: string;
    type: "string" | "number" | "boolean";
    description: string;
    required?: boolean;
  }>;
}
export interface ConnectorStatus {
  id: string;
  label: string;
  category: "apple" | "work" | "knowledge" | "security";
  available: boolean;
  connected: boolean;
  detail: string;
  setup?: string;
  actions: ConnectorActionSummary[];
}
export interface ConnectorSignal {
  id: string;
  service: string;
  action: string;
  observedAt: string;
  summary: string;
  notify: boolean;
}
export type ModelRole =
  | "conversation"
  | "general"
  | "coding"
  | "computer"
  | "browser"
  | "memory";
export interface ModelSelection { model: string; effort: string; }
export type ModelSettings = Record<ModelRole, ModelSelection>;
export interface ModelCatalogEntry {
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string;
}

export interface CompanionApi {
  sendConversation(text: string): Promise<ConversationUpdate>;
  startRealtimeVoice(offerSdp: string): Promise<RealtimeVoiceStartResult>;
  stopRealtimeVoice(): Promise<void>;
  getCurrentTask(): Promise<TaskSnapshot | null>;
  listConnectors(): Promise<ConnectorStatus[]>;
  startTask(goal: string, kind?: TaskKind, project?: string): Promise<TaskSnapshot>;
  listProjects(): Promise<ProjectList>;
  addProject(name: string, verification: VerificationPreset): Promise<SavedProject | null>;
  selectProject(query: string): Promise<SavedProject>;
  renameProject(id: string, name: string, aliases: string[]): Promise<SavedProject>;
  removeProject(id: string): Promise<void>;
  onProjectsUpdate(listener: (state: ProjectList) => void): () => void;
  getCodeReview(taskId: string): Promise<CodeReview>;
  listCodeReviews(): Promise<CodeReviewEntry[]>;
  onCodeReviewsUpdate(listener: () => void): () => void;
  applyCodeReview(taskId: string): Promise<{ applied: string[] } | { cancelled: true }>;
  discardCodeReview(taskId: string): Promise<{ discarded: true } | { cancelled: true }>;
  approveTask(taskId: string): Promise<void>;
  extendTaskApproval(taskId: string): Promise<void>;
  recoverTask(taskId: string): Promise<void>;
  denyTask(taskId: string): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  recallMemory(question: string): Promise<RecallAnswer>;
  getModelSettings(): Promise<ModelSettings>;
  updateModelSettings(settings: ModelSettings): Promise<ModelSettings>;
  listModels(): Promise<ModelCatalogEntry[]>;
  logDiagnostic(event: ClientDiagnosticEvent): void;
  onConversationUpdate(listener: (update: ConversationUpdate) => void): () => void;
  onRealtimeVoiceUpdate(listener: (update: RealtimeVoiceUpdate) => void): () => void;
  onTaskUpdate(listener: (task: TaskSnapshot) => void): () => void;
  onConnectorEvent(listener: (signal: ConnectorSignal) => void): () => void;
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
  usage?: TokenUsage;
}
