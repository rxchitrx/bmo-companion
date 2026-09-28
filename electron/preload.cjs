// Electron loads sandboxed preload scripts as CommonJS, even when the app's
// main process uses ESM. Keep this intentionally tiny and expose only the
// reviewed Companion IPC surface.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("companion", {
  sendConversation: (text) => ipcRenderer.invoke("conversation:send", text),
  startRealtimeVoice: (offerSdp) => ipcRenderer.invoke("voice:realtime:start", offerSdp),
  stopRealtimeVoice: () => ipcRenderer.invoke("voice:realtime:stop"),
  getCurrentTask: () => ipcRenderer.invoke("task:get-current"),
  listConnectors: () => ipcRenderer.invoke("connectors:list"),
  startTask: (goal, kind, project) => ipcRenderer.invoke("task:start", { goal, kind, project }),
  listProjects: () => ipcRenderer.invoke("projects:list"),
  addProject: (name, verification) => ipcRenderer.invoke("projects:add", name, verification),
  selectProject: (query) => ipcRenderer.invoke("projects:select", query),
  renameProject: (id, name, aliases) => ipcRenderer.invoke("projects:rename", id, name, aliases),
  removeProject: (id) => ipcRenderer.invoke("projects:remove", id),
  onProjectsUpdate: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("projects:update", handler);
    return () => ipcRenderer.removeListener("projects:update", handler);
  },
  getCodeReview: (taskId) => ipcRenderer.invoke("code-review:get", taskId),
  listCodeReviews: () => ipcRenderer.invoke("code-review:list"),
  onCodeReviewsUpdate: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("code-review:update", handler);
    return () => ipcRenderer.removeListener("code-review:update", handler);
  },
  applyCodeReview: (taskId) => ipcRenderer.invoke("code-review:apply", taskId),
  discardCodeReview: (taskId) => ipcRenderer.invoke("code-review:discard", taskId),
  approveTask: (taskId) => ipcRenderer.invoke("task:approve", taskId),
  extendTaskApproval: (taskId) => ipcRenderer.invoke("task:extend-approval", taskId),
  recoverTask: (taskId) => ipcRenderer.invoke("task:recover", taskId),
  denyTask: (taskId) => ipcRenderer.invoke("task:deny", taskId),
  cancelTask: (taskId) => ipcRenderer.invoke("task:cancel", taskId),
  recallMemory: (question) => ipcRenderer.invoke("memory:recall", question),
  getModelSettings: () => ipcRenderer.invoke("models:get-settings"),
  updateModelSettings: (settings) => ipcRenderer.invoke("models:update-settings", settings),
  listModels: () => ipcRenderer.invoke("models:list"),
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
  onConnectorEvent: (listener) => {
    const handler = (_event, signal) => listener(signal);
    ipcRenderer.on("connector:event", handler);
    return () => ipcRenderer.removeListener("connector:event", handler);
  },
});
