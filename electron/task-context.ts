import type { TaskSnapshot, TaskStatus } from "./task-runtime.js";

export function taskSnapshotToRealtimeContext(task: TaskSnapshot) {
  return [
    "[AUTHORITATIVE TASK STATE]",
    `Task ID: ${task.id}`,
    `Goal: ${task.goal}`,
    `Project: ${task.project ? `${task.project.name} (${task.project.root}, commit ${task.project.baseCommit.slice(0, 12)})` : "none"}`,
    `Status: ${task.status}`,
    `Approval: ${task.status === "waiting_approval" ? "pending" : task.approvalExpiresAt ? "granted" : "not active"}`,
    `Latest progress: ${task.progress.at(-1) ?? "none"}`,
    `Outcome: ${task.summary ?? "none yet"}`,
    `Retry of: ${task.retryOf ?? "none"}`,
    task.timing
      ? `Timing: ${task.timing.totalMs}ms total (${task.timing.startupMs} startup, ${task.timing.executionMs} execution, ${task.timing.settlingMs} settling, ${task.timing.shutdownMs} shutdown)`
      : "Timing: not available yet",
    "Treat this as ground truth. Do not claim a different Task state.",
  ].join("\n");
}

export function taskStatusSpeech(
  task: TaskSnapshot,
  previousStatus?: TaskStatus,
) {
  if (task.status === previousStatus) return null;
  if (task.status === "running") return "Approved. I’ve started the task.";
  if (task.status === "completed") {
    return task.summary ?? "The task is complete.";
  }
  if (task.status === "failed") {
    return task.summary ?? "The task could not be completed.";
  }
  if (task.status === "cancelled") return "Stopped. I’m still listening.";
  if (task.status === "needs_decision") {
    return task.summary ?? "I need your decision before I can continue.";
  }
  if (task.status === "suspended") {
    return task.summary ?? "The task is paused and needs recovery.";
  }
  return null;
}
