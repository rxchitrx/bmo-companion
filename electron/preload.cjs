// Electron loads sandboxed preload scripts as CommonJS, even when the app's
// main process uses ESM. Keep this intentionally tiny and expose only the
// reviewed Companion IPC surface.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("companion", {
  startTask: (goal) => ipcRenderer.invoke("task:start", goal),
  approveTask: (taskId) => ipcRenderer.invoke("task:approve", taskId),
  denyTask: (taskId) => ipcRenderer.invoke("task:deny", taskId),
  cancelTask: (taskId) => ipcRenderer.invoke("task:cancel", taskId),
  onTaskUpdate: (listener) => {
    const handler = (_event, task) => listener(task);
    ipcRenderer.on("task:update", handler);
    return () => ipcRenderer.removeListener("task:update", handler);
  },
});
