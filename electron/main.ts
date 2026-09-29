import { app, BrowserWindow, dialog, ipcMain, powerMonitor, screen, session } from "electron";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { createCodexInteractionEngine } from "./codex-engine.js";
import { createBmoTaskEngine } from "./task-engine.js";
import type { CompanionConversationEngine, CompanionVoiceEngine, ConversationUpdate, RealtimeVoiceUpdate } from "./companion-engine.js";
import { diagnosticLog, sanitizeDiagnostic, textMeta } from "./diagnostics.js";
import { JsonlActivityLedger, JsonTaskStore, TaskRuntime, type TaskSnapshot } from "./task-runtime.js";
import { CompanionMemoryService, JsonMemoryStore } from "./memory-service.js";
import { ComputerUseHealth } from "./computer-use-health.js";
import {
  listAvailableModels,
  ModelSettingsStore,
  type ModelSettings,
  type TaskKind,
} from "./model-settings.js";
import { AppleBridge, defaultAppleBridgePaths } from "./apple-bridge.js";
import { SpawnConnectorCommandRunner } from "./connector-command.js";
import {
  ConnectorGateway,
  ConnectorRoutingTaskExecutor,
} from "./connector-gateway.js";
import { ConnectorToolBridge } from "./connector-tools.js";
import { connectorCallGoal, createConnectors } from "./connectors.js";
import { TASK_GOAL_MAX_CHARS } from "./context-packet.js";
import { MinimalExecutionKernel } from "./execution-kernel.js";
import { JsonToolCallJournal, ToolDispatcher } from "./tool-dispatch.js";
import { ProjectRegistry, type VerificationPreset } from "./project-registry.js";
import { CodeReviewService } from "./code-review.js";
import { LayaRouter } from "./laya-router.js";
import { BmoInteractionRouter, handleDirectTypedRequest } from "./interaction-router.js";
import { isOwnerStopTranscript } from "./realtime-voice-client.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let runtime: TaskRuntime;
let memory: CompanionMemoryService;
let modelSettings: ModelSettingsStore;
let conversation: CompanionConversationEngine;
let realtimeVoice: CompanionVoiceEngine;
let connectorGateway: ConnectorGateway;
let projects: ProjectRegistry;
let codeReview: CodeReviewService;
let interactionRouter: BmoInteractionRouter;
const layaRouter = new LayaRouter();
let modelCatalogPromise: ReturnType<typeof listAvailableModels> | null = null;
const computerUseHealth = new ComputerUseHealth();

function emitConversation(update: ConversationUpdate) {
  diagnosticLog("main", "conversation.update.emit", {
    requestId: update.requestId,
    status: update.status,
    transport: update.transport,
    assistantText: update.assistantText,
    warning: update.warning,
    error: update.error,
    windowAvailable: !!mainWindow,
  });
  mainWindow?.webContents.send("conversation:update", update);
}

function emitRealtimeVoice(update: RealtimeVoiceUpdate) {
  diagnosticLog("main", "voice.realtime.update.emit", {
    sessionId: update.sessionId,
    status: update.status,
    role: update.role,
    transcript: update.transcript,
    error: update.error,
    reason: update.reason,
    windowAvailable: !!mainWindow,
  });
  mainWindow?.webContents.send("voice:realtime:update", update);
}

function createStage() {
  const primary = screen.getPrimaryDisplay();
  const displays = screen.getAllDisplays();
  const selected =
    displays.find((display) => display.id !== primary.id) ?? primary;
  diagnosticLog("main", "stage.create", {
    displayCount: displays.length,
    selectedDisplayId: selected.id,
    selectedBounds: selected.bounds,
    development: process.env.NODE_ENV === "development",
  });

  mainWindow = new BrowserWindow({
    ...selected.bounds,
    frame: false,
    resizable: false,
    movable: false,
    fullscreenable: true,
    backgroundColor: "#78cdb8",
    webPreferences: {
      preload: join(currentDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setBounds(selected.bounds);
  if (process.platform === "darwin") mainWindow.setSimpleFullScreen(true);
  else mainWindow.setFullScreen(true);

  if (process.env.NODE_ENV === "development") {
    void mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    void mainWindow.loadFile(join(currentDir, "..", "dist-ui", "index.html"));
  }
  mainWindow.webContents.on("did-start-loading", () =>
    diagnosticLog("main", "stage.loading.started"));
  mainWindow.webContents.on("did-finish-load", () =>
    diagnosticLog("main", "stage.loading.finished", {
      url: mainWindow?.webContents.getURL(),
    }));
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, url) =>
    diagnosticLog("main", "stage.loading.failed", {
      errorCode,
      error: errorDescription,
      url,
    }));
  mainWindow.webContents.on("render-process-gone", (_event, details) =>
    diagnosticLog("main", "stage.renderer.gone", details as unknown as Record<string, unknown>));
  mainWindow.on("unresponsive", () => diagnosticLog("main", "stage.unresponsive"));
  mainWindow.on("responsive", () => diagnosticLog("main", "stage.responsive"));
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  projects = new ProjectRegistry(join(app.getPath("userData"), "projects.json"));
  codeReview = new CodeReviewService(join(app.getPath("userData"), "code-workspaces"), join(app.getPath("userData"), "code-review-journal.json"));
  diagnosticLog("main", "application.ready", {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
  });
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const url = webContents.getURL();
      const trustedOrigin =
        url.startsWith("http://127.0.0.1:5173") ||
        url.startsWith("file://");
      const mediaTypes =
        "mediaTypes" in details ? details.mediaTypes ?? [] : [];
      const microphoneOnly =
        permission === "media" &&
        mediaTypes.length > 0 &&
        mediaTypes.every((mediaType: string) => mediaType === "audio");
      const allowed = trustedOrigin && microphoneOnly;
      diagnosticLog("main", "permission.request", {
        permission,
        url,
        mediaTypes,
        trustedOrigin,
        allowed,
      });
      callback(allowed);
    },
  );
  modelSettings = new ModelSettingsStore(join(app.getPath("userData"), "model-settings.json"));
  await modelSettings.load();
  memory = new CompanionMemoryService(new JsonMemoryStore(join(app.getPath("userData"), "companion-memory.json")));
  const connectorRunner = new SpawnConnectorCommandRunner();
  const applePaths = defaultAppleBridgePaths(currentDir, app.getPath("userData"));
  const appleBridge = new AppleBridge(
    connectorRunner,
    applePaths.sourcePath,
    applePaths.binaryPath,
  );
  connectorGateway = new ConnectorGateway(
    createConnectors(connectorRunner, appleBridge),
    undefined,
    new ToolDispatcher(new JsonToolCallJournal(join(app.getPath("userData"), "tool-calls.json"))),
  );
  const activityLedger = new JsonlActivityLedger(
    join(app.getPath("userData"), "activity-ledger.jsonl"),
  );
  const taskEngine = createBmoTaskEngine(
    computerUseHealth,
    join(app.getPath("userData"), "code-workspaces"),
  );
  runtime = new TaskRuntime(
    new MinimalExecutionKernel(
      new ConnectorRoutingTaskExecutor(
        connectorGateway,
        taskEngine.taskExecutor,
      ),
      {
        selectConnectorCapabilities: (request) =>
          connectorGateway.selectCapabilities(request),
      },
    ),
    activityLedger,
    (task) => {
      mainWindow?.webContents.send("task:update", task);
      void realtimeVoice?.syncTask(task);
      if (task.codeReview) void codeReview.remember(task).then(() => {
        mainWindow?.webContents.send("code-review:update");
      }).catch((error) => diagnosticLog("main", "code_review.save_failed", { error: String(error) }));
    },
    undefined,
    new JsonTaskStore(join(app.getPath("userData"), "active-task.json")),
    taskEngine.recoveryObserver,
    undefined,
    undefined,
    memory,
  );
  let connectorTools: ConnectorToolBridge;
  let voiceConnectorTools: ConnectorToolBridge;
  const startScopedTask = async (goal: string, kind: "general" | "coding" | "computer" | "browser", retryOf?: TaskSnapshot, projectQuery?: string) => {
    const selection = modelSettings.selection(kind);
    const project = kind === "coding" ? await projects.snapshot(projectQuery) : undefined;
    return retryOf
      ? runtime.createRetry(retryOf.id, goal, { kind, ...selection, project })
      : runtime.create(goal, { kind, ...selection, project });
  };
  interactionRouter = new BmoInteractionRouter({
    path: join(app.getPath("userData"), "interaction-session.json"),
    readTask: () => runtime.currentTask(),
    startTask: startScopedTask,
    stopTask: () => runtime.cancelActive(),
    listProjects: () => projects.list(),
    selectProject: async (query) => {
      const project = await projects.select(query);
      mainWindow?.webContents.send("projects:update", await projects.list());
      return project;
    },
    laya: layaRouter,
    onBeginTurn: () => {
      connectorTools?.cancelActiveReads(); connectorTools?.resetDiscovery();
      voiceConnectorTools?.cancelActiveReads(); voiceConnectorTools?.resetDiscovery();
    },
  });
  await interactionRouter.load();
  connectorTools = new ConnectorToolBridge({
    gateway: connectorGateway,
    startTask: (call) => runtime.create(connectorCallGoal(call), {
      kind: "connector",
      connectorCall: call,
    }),
    readCurrentTask: () => runtime.currentTask(),
    authorize: () => interactionRouter.authorize("typed", "connector"),
  });
  voiceConnectorTools = new ConnectorToolBridge({
    gateway: connectorGateway,
    startTask: (call) => runtime.create(connectorCallGoal(call), {
      kind: "connector",
      connectorCall: call,
    }),
    readCurrentTask: () => runtime.currentTask(),
    authorize: () => interactionRouter.authorize("voice", "connector"),
  });
  const interactions = createCodexInteractionEngine({
    readTask: () => runtime.currentTask(),
    readConversationModel: () => modelSettings.selection("conversation"),
    connectorTools,
    voiceConnectorTools,
    startTask: startScopedTask,
    stopTask: () => runtime.cancelActive(),
    listProjects: () => projects.list(),
    selectProject: async (query) => {
      if (["running", "waiting_approval", "suspended", "needs_decision"].includes(runtime.currentTask()?.status ?? "")) throw new Error("Finish or cancel the active Task before switching projects.");
      const project = await projects.select(query);
      mainWindow?.webContents.send("projects:update", await projects.list());
      return project;
    },
    router: layaRouter,
    interactionRouter,
  });
  conversation = interactions.conversation;
  realtimeVoice = interactions.voice;
  void runtime.restore().then(async (task) => {
    computerUseHealth.observeFailure(task?.summary);
    if (task?.codeReview) await codeReview.remember(task);
  });
  const reminderClock = setInterval(() => void runtime.sendDueReminders(), 30_000);
  reminderClock.unref();
  powerMonitor.on("lock-screen", () => {
    diagnosticLog("main", "power.lock_screen");
    void runtime.setExecutionSurfaceAvailable(false);
  });
  powerMonitor.on("unlock-screen", () => {
    diagnosticLog("main", "power.unlock_screen");
    void runtime.setExecutionSurfaceAvailable(true);
  });
  createStage();
});

ipcMain.handle("conversation:send", async (_event, rawText: string) => {
  const text = rawText.trim();
  if (!text) throw new Error("Conversation message cannot be empty.");
  if (text.length > 20_000) throw new Error("Conversation message is too long.");
  const startedAt = Date.now();
  diagnosticLog("main", "ipc.conversation.send", { text: textMeta(text) });
  try {
    const localReply = (assistantText: string): ConversationUpdate => {
      const update: ConversationUpdate = { requestId: randomUUID(), status: "completed", transport: "bmo-route", assistantText };
      emitConversation(update);
      return update;
    };
    const direct = await handleDirectTypedRequest(interactionRouter, text, isOwnerStopTranscript(text));
    if (direct !== null) {
      const update = localReply(direct);
      void realtimeVoice.syncSharedTypedContext();
      return update;
    }
    const result = await conversation.send(text, emitConversation);
    void realtimeVoice.syncSharedTypedContext();
    diagnosticLog("main", "ipc.conversation.resolved", {
      requestId: result.requestId,
      status: result.status,
      transport: result.transport,
      elapsedMs: Date.now() - startedAt,
      assistantText: result.assistantText,
    });
    return result;
  } catch (error) {
    diagnosticLog("main", "ipc.conversation.rejected", {
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
});

ipcMain.handle("task:get-current", () => runtime.currentTask());
ipcMain.handle("connectors:list", () => connectorGateway.statuses());

ipcMain.handle("voice:realtime:start", async (_event, rawOfferSdp: string) => {
  const offerSdp = String(rawOfferSdp ?? "");
  if (!offerSdp.startsWith("v=0")) throw new Error("Invalid WebRTC SDP offer.");
  if (offerSdp.length > 200_000) throw new Error("WebRTC SDP offer is too large.");
  const startedAt = Date.now();
  diagnosticLog("main", "ipc.voice.realtime.start", { sdp: offerSdp });
  try {
    const result = await realtimeVoice.start(offerSdp, emitRealtimeVoice);
    diagnosticLog("main", "ipc.voice.realtime.started", {
      sessionId: result.sessionId,
      elapsedMs: Date.now() - startedAt,
      sdp: result.answerSdp,
    });
    return result;
  } catch (error) {
    diagnosticLog("main", "ipc.voice.realtime.rejected", {
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
});

ipcMain.handle("voice:realtime:stop", async () => {
  diagnosticLog("main", "ipc.voice.realtime.stop");
  await realtimeVoice.stop("renderer requested stop");
});

ipcMain.handle("task:start", async (_event, payload: { goal?: unknown; kind?: unknown; project?: unknown }) => {
  const goal = String(payload?.goal ?? "").trim();
  const rawKind = String(payload?.kind ?? "general");
  const kind = (["general", "coding", "computer", "browser"].includes(rawKind)
    ? rawKind
    : "general") as TaskKind;
  if (!goal) throw new Error("Task goal cannot be empty.");
  if (goal.length > TASK_GOAL_MAX_CHARS) {
    throw new Error(`Task goal exceeds the ${TASK_GOAL_MAX_CHARS}-character Context Packet limit.`);
  }
  interactionRouter.beginTurn("typed", goal, kind);
  diagnosticLog("main", "ipc.task.start", { goal: textMeta(goal) });
  return interactionRouter.createTask("typed", goal, kind, false, typeof payload?.project === "string" ? payload.project : undefined);
});
ipcMain.handle("projects:list", () => projects.list());
ipcMain.handle("projects:add", async (_event, name: string, verification: VerificationPreset) => {
  const choice = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Choose a project folder" });
  if (choice.canceled || !choice.filePaths[0]) return null;
  const project = await projects.add(choice.filePaths[0], name, verification);
  mainWindow?.webContents.send("projects:update", await projects.list());
  return project;
});
ipcMain.handle("projects:select", async (_event, query: string) => {
  if (["running", "waiting_approval", "suspended", "needs_decision"].includes(runtime.currentTask()?.status ?? "")) throw new Error("Finish or cancel the active Task before switching projects.");
  const project = await projects.select(query);
  mainWindow?.webContents.send("projects:update", await projects.list());
  return project;
});
ipcMain.handle("projects:rename", async (_event, id: string, name: string, aliases: string[]) => {
  const project = await projects.rename(id, name, aliases);
  mainWindow?.webContents.send("projects:update", await projects.list());
  return project;
});
ipcMain.handle("projects:remove", async (_event, id: string) => {
  if (runtime.currentTask()?.project?.id === id && ["running", "waiting_approval", "suspended", "needs_decision"].includes(runtime.currentTask()?.status ?? "")) throw new Error("Finish or cancel the active Task before removing its project.");
  await projects.remove(id);
  mainWindow?.webContents.send("projects:update", await projects.list());
});
ipcMain.handle("code-review:get", async (_event, taskId: string) => {
  const task = runtime.currentTask()?.id === taskId ? runtime.currentTask() : await codeReview.task(taskId);
  if (!task) throw new Error("No saved code result has this Task ID.");
  return codeReview.review(task);
});
ipcMain.handle("code-review:list", () => codeReview.list());
ipcMain.handle("code-review:apply", async (_event, taskId: string) => {
  const task = runtime.currentTask()?.id === taskId ? runtime.currentTask() : await codeReview.task(taskId);
  if (!task) throw new Error("No saved code result has this Task ID.");
  const choice = await dialog.showMessageBox({ type: "question", buttons: ["Cancel", "Apply changes"], defaultId: 0, cancelId: 0,
    message: `Apply this verified result to ${task.project?.name ?? "the project"}?`, detail: task.project?.root ?? "" });
  if (choice.response !== 1) return { cancelled: true };
  const result = await codeReview.apply(task);
  mainWindow?.webContents.send("code-review:update");
  return result;
});
ipcMain.handle("code-review:discard", async (_event, taskId: string) => {
  const task = runtime.currentTask()?.id === taskId ? runtime.currentTask() : await codeReview.task(taskId);
  if (!task) throw new Error("No saved code result has this Task ID.");
  const choice = await dialog.showMessageBox({ type: "warning", buttons: ["Keep result", "Discard isolated result"], defaultId: 0, cancelId: 0,
    message: "Discard this isolated code result?", detail: "BMO will remove only this Task's worktree. The original project folder stays unchanged." });
  if (choice.response !== 1) return { cancelled: true };
  const result = await codeReview.discard(task);
  mainWindow?.webContents.send("code-review:update");
  return result;
});
ipcMain.handle("task:approve", (_event, id: string) => {
  diagnosticLog("main", "ipc.task.approve", { taskId: id });
  return runtime.approve(id);
});
ipcMain.handle("task:extend-approval", (_event, id: string) => {
  diagnosticLog("main", "ipc.task.extend_approval", { taskId: id });
  return runtime.extendApproval(id);
});
ipcMain.handle("task:recover", (_event, id: string) => {
  diagnosticLog("main", "ipc.task.recover", { taskId: id });
  return runtime.recover(id);
});
ipcMain.handle("task:deny", (_event, id: string) => {
  diagnosticLog("main", "ipc.task.deny", { taskId: id });
  return runtime.deny(id);
});
ipcMain.handle("task:cancel", (_event, id: string) => {
  diagnosticLog("main", "ipc.task.cancel", { taskId: id });
  return runtime.cancel(id);
});
ipcMain.handle("memory:recall", async (_event, question: string) => {
  diagnosticLog("main", "ipc.memory.recall", { text: textMeta(question) });
  const local = await memory.recall(question.trim());
  if (local.references.length === 0) return local;
  const selection = modelSettings.selection("memory");
  const synthesis = await conversation.synthesizeMemory(
    question.trim(),
    local.answer,
    selection,
  );
  return { ...local, answer: synthesis.text, usage: synthesis.usage };
});
ipcMain.handle("models:get-settings", () => modelSettings.get());
ipcMain.handle("models:update-settings", (_event, settings: ModelSettings) =>
  modelSettings.update(settings));
ipcMain.handle("models:list", () => {
  modelCatalogPromise ??= listAvailableModels().catch((error) => {
    modelCatalogPromise = null;
    throw error;
  });
  return modelCatalogPromise;
});
ipcMain.on("diagnostic:client", (_event, payload: unknown) => {
  diagnosticLog("renderer", "client.event", {
    payload: sanitizeDiagnostic(payload),
  });
});

app.on("before-quit", () => {
  layaRouter.close();
  diagnosticLog("main", "application.before_quit");
  void realtimeVoice.stop("application shutdown");
  conversation.stop();
});
app.on("window-all-closed", () => app.quit());
