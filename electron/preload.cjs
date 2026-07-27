// Electron loads sandboxed preload scripts as CommonJS, even when the app's
// main process uses ESM. Keep this intentionally tiny and expose only the
// reviewed Companion IPC surface.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("companion", {
  sendConversation: (text) => ipcRenderer.invoke("conversation:send", text),
  startRealtimeVoice: (offerSdp) => ipcRenderer.invoke("voice:realtime:start", offerSdp),
  stopRealtimeVoice: () => ipcRenderer.invoke("voice:realtime:stop"),
  startTask: (goal) => ipcRenderer.invoke("task:start", goal),
  approveTask: (taskId) => ipcRenderer.invoke("task:approve", taskId),
  extendTaskApproval: (taskId) => ipcRenderer.invoke("task:extend-approval", taskId),
  recoverTask: (taskId) => ipcRenderer.invoke("task:recover", taskId),
  denyTask: (taskId) => ipcRenderer.invoke("task:deny", taskId),
  cancelTask: (taskId) => ipcRenderer.invoke("task:cancel", taskId),
  recallMemory: (question) => ipcRenderer.invoke("memory:recall", question),
  logDiagnostic: (event) => ipcRenderer.send("diagnostic:client", event),
  onConversationUpdate: (listener) => {
    const handler = (_event, update) => listener(update);
    ipcRenderer.on("conversation:update", handler);
    return () => ipcRenderer.removeListener("conversation:update", handler);
  },
  onRealtimeVoiceUpdate: (listener) => {
    const handler = (_event, update) => listener(update);
    ipcRenderer.on("voice:realtime:update", handler);
    return () => ipcRenderer.removeListener("voice:realtime:update", handler);
  },
  onTaskUpdate: (listener) => {
    const handler = (_event, task) => listener(task);
    ipcRenderer.on("task:update", handler);
    return () => ipcRenderer.removeListener("task:update", handler);
  },
});
