import { CodexRecoveryObserver, CodexTaskExecutor } from "./codex-adapter.js";
import { CodexConversationClient } from "./conversation-client.js";
import { CodexRealtimeVoiceClient } from "./realtime-voice-client.js";
import type { CompanionEngine } from "./companion-engine.js";
import type { TaskSnapshot } from "./task-runtime.js";
import type { ConnectorToolBridge } from "./connector-tools.js";
import type { ComputerUseHealth } from "./computer-use-health.js";
import type { SavedProject } from "./project-registry.js";
import type { LayaRouter } from "./laya-router.js";
import type { BmoInteractionRouter } from "./interaction-router.js";

export function createCodexTaskEngine(computerUseHealth: ComputerUseHealth, codeWorkspacesDirectory: string): Pick<CompanionEngine, "taskExecutor" | "recoveryObserver"> {
  return {
    taskExecutor: new CodexTaskExecutor(computerUseHealth, codeWorkspacesDirectory),
    recoveryObserver: new CodexRecoveryObserver(),
  };
}

export function createCodexInteractionEngine(options: {
  readTask: () => TaskSnapshot | null;
  readConversationModel: () => { model: string; effort: string };
  connectorTools: ConnectorToolBridge;
  voiceConnectorTools?: ConnectorToolBridge;
  startTask: (goal: string, kind: "general" | "coding" | "computer" | "browser", retryOf?: TaskSnapshot, project?: string) => Promise<TaskSnapshot>;
  stopTask: () => Promise<boolean>;
  listProjects?: () => Promise<{ projects: SavedProject[]; activeId?: string }>;
  selectProject?: (query: string) => Promise<SavedProject>;
  router?: LayaRouter;
  interactionRouter?: BmoInteractionRouter;
}): Pick<CompanionEngine, "conversation" | "voice"> {
  return {
    conversation: new CodexConversationClient(options.readTask, options.readConversationModel, options.connectorTools, options.interactionRouter),
    voice: new CodexRealtimeVoiceClient(options.startTask, options.stopTask, options.readTask, options.voiceConnectorTools ?? options.connectorTools, options.listProjects, options.selectProject, options.router, options.interactionRouter),
  };
}
