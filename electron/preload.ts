import { contextBridge, ipcRenderer } from "electron";
import type { TaskSnapshot } from "./task-runtime.js";

contextBridge.exposeInMainWorld("companion", {
  startTask: (goal: string) => ipcRenderer.invoke("task:start", goal),
  approveTask: (taskId: string) => ipcRenderer.invoke("task:approve", taskId),
  denyTask: (taskId: string) => ipcRenderer.invoke("task:deny", taskId),
  cancelTask: (taskId: string) => ipcRenderer.invoke("task:cancel", taskId),
  onTaskUpdate: (listener: (task: TaskSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, task: TaskSnapshot) => listener(task);
    ipcRenderer.on("task:update", handler);
    return () => ipcRenderer.removeListener("task:update", handler);
  },
});
