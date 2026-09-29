import type { ConnectorSignal } from "./connector-events.js";
import type { RecoveryObserver, TaskExecutor, TaskSnapshot, TokenUsage } from "./task-runtime.js";

export interface ConversationUpdate {
  requestId: string;
  status: "connecting" | "sending" | "responding" | "completed" | "degraded" | "failed";
  transport: "realtime" | "codex-turn" | "bmo-route";
  assistantText?: string;
  warning?: string;
  error?: string;
}

export interface RealtimeVoiceUpdate {
  sessionId: string;
  status: "connecting" | "connected" | "listening" | "thinking" | "speaking" | "closed" | "failed";
  role?: "user" | "assistant";
  transcript?: string;
  error?: string;
  reason?: string;
}

export interface RealtimeVoiceStartResult {
  sessionId: string;
  answerSdp: string;
}

/** BMO's runtime contract. A provider implements transport; BMO owns tasks and policy. */
export interface CompanionConversationEngine {
  send(text: string, emit: (update: ConversationUpdate) => void): Promise<ConversationUpdate>;
  synthesizeMemory(question: string, answer: string, selection: { model: string; effort: string }): Promise<{ text: string; usage?: TokenUsage }>;
  stop(): void;
}

export interface CompanionVoiceEngine {
  start(offerSdp: string, emit: (update: RealtimeVoiceUpdate) => void): Promise<RealtimeVoiceStartResult>;
  stop(reason?: string): Promise<void>;
  syncTask(task: TaskSnapshot): Promise<void>;
  syncConnectorSignal(signal: ConnectorSignal): Promise<boolean>;
  syncSharedTypedContext(): Promise<boolean>;
}

export interface CompanionEngine {
  taskExecutor: TaskExecutor;
  recoveryObserver: RecoveryObserver;
  conversation: CompanionConversationEngine;
  voice: CompanionVoiceEngine;
}
