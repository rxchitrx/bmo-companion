import { app, BrowserWindow, ipcMain, powerMonitor, screen, session } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CodexRecoveryObserver, CodexTaskExecutor } from "./codex-adapter.js";
import { CodexConversationClient, type ConversationUpdate } from "./conversation-client.js";
import { diagnosticLog, sanitizeDiagnostic, textMeta } from "./diagnostics.js";
import {
  CodexRealtimeVoiceClient,
  type RealtimeVoiceUpdate,
} from "./realtime-voice-client.js";
import { JsonlActivityLedger, JsonTaskStore, TaskRuntime } from "./task-runtime.js";
import { CompanionMemoryService, JsonMemoryStore } from "./memory-service.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let runtime: TaskRuntime;
let memory: CompanionMemoryService;
const conversation = new CodexConversationClient();
const realtimeVoice = new CodexRealtimeVoiceClient();

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

app.whenReady().then(() => {
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
  memory = new CompanionMemoryService(new JsonMemoryStore(join(app.getPath("userData"), "companion-memory.json")));
  runtime = new TaskRuntime(
    new CodexTaskExecutor(),
    new JsonlActivityLedger(join(app.getPath("userData"), "activity-ledger.jsonl")),
    (task) => mainWindow?.webContents.send("task:update", task),
    undefined,
    new JsonTaskStore(join(app.getPath("userData"), "active-task.json")),
    new CodexRecoveryObserver(),
    undefined,
    undefined,
    memory,
  );
  void runtime.restore();
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
    const result = await conversation.send(text, emitConversation);
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

ipcMain.handle("task:start", (_event, goal: string) => {
  diagnosticLog("main", "ipc.task.start", { goal: textMeta(goal) });
  return runtime.create(goal.trim());
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
ipcMain.handle("memory:recall", (_event, question: string) => {
  diagnosticLog("main", "ipc.memory.recall", { text: textMeta(question) });
  return memory.recall(question.trim());
});
ipcMain.on("diagnostic:client", (_event, payload: unknown) => {
  diagnosticLog("renderer", "client.event", {
    payload: sanitizeDiagnostic(payload),
  });
});

app.on("before-quit", () => {
  diagnosticLog("main", "application.before_quit");
  void realtimeVoice.stop("application shutdown");
  conversation.stop();
});
app.on("window-all-closed", () => app.quit());
