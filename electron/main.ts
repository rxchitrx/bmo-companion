import { app, BrowserWindow, ipcMain, powerMonitor, screen } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CodexRecoveryObserver, CodexTaskExecutor } from "./codex-adapter.js";
import { JsonlActivityLedger, JsonTaskStore, TaskRuntime } from "./task-runtime.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let runtime: TaskRuntime;

function createStage() {
  const primary = screen.getPrimaryDisplay();
  const displays = screen.getAllDisplays();
  const selected =
    displays.find((display) => display.id !== primary.id) ?? primary;

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
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(() => {
  runtime = new TaskRuntime(
    new CodexTaskExecutor(),
    new JsonlActivityLedger(join(app.getPath("userData"), "activity-ledger.jsonl")),
    (task) => mainWindow?.webContents.send("task:update", task),
    undefined,
    new JsonTaskStore(join(app.getPath("userData"), "active-task.json")),
    new CodexRecoveryObserver(),
  );
  void runtime.restore();
  const reminderClock = setInterval(() => void runtime.sendDueReminders(), 30_000);
  reminderClock.unref();
  powerMonitor.on("lock-screen", () => void runtime.setExecutionSurfaceAvailable(false));
  powerMonitor.on("unlock-screen", () => void runtime.setExecutionSurfaceAvailable(true));
  createStage();
});

ipcMain.handle("task:start", (_event, goal: string) => runtime.create(goal.trim()));
ipcMain.handle("task:approve", (_event, id: string) => runtime.approve(id));
ipcMain.handle("task:extend-approval", (_event, id: string) => runtime.extendApproval(id));
ipcMain.handle("task:recover", (_event, id: string) => runtime.recover(id));
ipcMain.handle("task:deny", (_event, id: string) => runtime.deny(id));
ipcMain.handle("task:cancel", (_event, id: string) => runtime.cancel(id));

app.on("window-all-closed", () => app.quit());
