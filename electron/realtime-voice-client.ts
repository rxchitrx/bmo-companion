import { randomUUID } from "node:crypto";
import {
  AppServerConnection,
  type AppServerRequestReply,
  type JsonRpcMessage,
} from "./conversation-client.js";
import { diagnosticLog, textMeta } from "./diagnostics.js";
import {
  taskSnapshotToRealtimeContext,
  taskStatusSpeech,
} from "./task-context.js";
import type { TaskSnapshot } from "./task-runtime.js";

export {
  taskSnapshotToRealtimeContext,
  taskStatusSpeech,
} from "./task-context.js";

export type RealtimeVoiceStatus =
  | "connecting"
  | "connected"
  | "listening"
  | "thinking"
  | "speaking"
  | "closed"
  | "failed";

export interface RealtimeVoiceUpdate {
  sessionId: string;
  status: RealtimeVoiceStatus;
  role?: "user" | "assistant";
  transcript?: string;
  error?: string;
  reason?: string;
}

export interface RealtimeVoiceStartResult {
  sessionId: string;
  answerSdp: string;
}

const REALTIME_PROMPT = [
  "You are BMO, Rachit's warm, concise personal companion.",
  "This is a live voice conversation, so respond naturally and briefly.",
  "You control the computer through the control_computer tool; this is your computer-control interface.",
  "When the user asks you to perform a computer, browser, file, coding, connector, or external-service action, call control_computer exactly once with the complete goal.",
  "If the tool reports that approval is pending, tell the user once and wait. Never claim approval is missing without calling get_task_state first.",
  "Use get_task_state whenever the user asks whether a Task was approved, what is happening, whether it is still running, or what finished.",
  "If a Task failed because Computer Use lost verification, explain that the Mac may already have changed. Do not create another Task unless the user explicitly asks to retry.",
  "Authoritative Task State messages are ground truth and override anything previously said in the conversation.",
  "Do not attempt a separate capability, workaround, or fallback outside control_computer.",
  "When the user says stop or cancel, stop only the current Task immediately. Do not retry or continue that Task. Stay in the voice conversation and remain available.",
].join(" ");

export function isOwnerStopTranscript(transcript: string) {
  const normalized = transcript
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:hey )?bmo\s+/, "");
  return /^(?:please\s+)?(?:stop|cancel|abort)(?:\s+(?:please|now|everything|all|that|this|it|the task|the current task|what youre doing|what you are doing))*$/.test(normalized);
}

export function createRealtimeConversationThreadParams(cwd: string) {
  return {
    cwd,
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
    environments: [],
    selectedCapabilityRoots: [],
    dynamicTools: [
      {
        type: "function",
        name: "control_computer",
        description: "BMO's computer-control interface. Starts a scoped Task from the owner's spoken request. The Task runs as soon as any required approval is granted in the BMO app.",
        inputSchema: {
          type: "object",
          properties: {
            goal: {
              type: "string",
              description: "The complete action the owner asked BMO to perform.",
            },
            kind: {
              type: "string",
              enum: ["general", "coding", "computer", "browser"],
              description: "Use browser for websites, computer for visible Mac apps, coding for source-code work, and general otherwise.",
            },
            retry: {
              type: "boolean",
              description: "True only when the owner explicitly asked to retry a just-finished matching Task.",
            },
          },
          required: ["goal", "kind", "retry"],
          additionalProperties: false,
        },
      },
      {
        type: "function",
        name: "get_task_state",
        description: "Read BMO's authoritative current Task state, including approval, execution progress, completion, failure, or cancellation. Call this instead of guessing.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ],
    config: {
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
      },
    },
  };
}

export class CodexRealtimeVoiceClient {
  private connection: AppServerConnection | null = null;
  private threadId: string | null = null;
  private sessionId: string | null = null;
  private removeNotificationListener: (() => void) | null = null;
  private emit: ((update: RealtimeVoiceUpdate) => void) | null = null;
  private transcripts: Record<"user" | "assistant", string> = {
    user: "",
    assistant: "",
  };
  private lastPublishedStatus: RealtimeVoiceStatus | null = null;
  private ownerStopInProgress = false;
  private lastUserTranscriptWasStop = false;
  private latestTask: TaskSnapshot | null = null;
  private lastSyncedTask: TaskSnapshot | null = null;
  private lastProgressSyncAt = 0;
  private lastTerminalTaskAt = 0;

  constructor(
    private readonly startComputerTask: (
      goal: string,
      kind: "general" | "coding" | "computer" | "browser",
    ) => Promise<TaskSnapshot> =
      async () => { throw new Error("Task delegation is unavailable."); },
    private readonly stopActiveTask: () => Promise<boolean> =
      async () => false,
    private readonly readCurrentTask: () => TaskSnapshot | null =
      () => null,
  ) {}

  get active() {
    return !!this.connection?.running && !!this.threadId && !!this.sessionId;
  }

  async start(
    offerSdp: string,
    emit: (update: RealtimeVoiceUpdate) => void,
  ): Promise<RealtimeVoiceStartResult> {
    await this.stop("starting a new voice session");
    const sessionId = randomUUID();
    this.sessionId = sessionId;
    this.emit = emit;
    this.transcripts = { user: "", assistant: "" };
    this.lastPublishedStatus = null;
    this.lastUserTranscriptWasStop = false;
    this.latestTask = this.readCurrentTask();
    this.lastSyncedTask = this.latestTask
      ? structuredClone(this.latestTask)
      : null;
    this.lastProgressSyncAt = 0;
    this.publish({ sessionId, status: "connecting" });
    diagnosticLog("voice.realtime", "session.start.requested", {
      sessionId,
      sdp: offerSdp,
      version: "v3",
      outputModality: "audio",
    });

    const connection = new AppServerConnection(
      "voice.realtime",
      (message) => this.handleServerRequest(message),
    );
    this.connection = connection;
    this.removeNotificationListener = connection.onNotification((message) =>
      this.handleNotification(message));

    try {
      await connection.start();
      const thread = await connection.request(
        "thread/start",
        createRealtimeConversationThreadParams(process.cwd()),
      );
      this.threadId = thread.thread.id;
      diagnosticLog("voice.realtime", "thread.created", {
        sessionId,
        threadId: this.threadId,
      });

      await connection.request("thread/realtime/start", {
        threadId: this.threadId,
        outputModality: "audio",
        version: "v3",
        includeStartupContext: false,
        initialItems: this.latestTask
          ? [{
              role: "developer",
              text: taskSnapshotToRealtimeContext(this.latestTask),
            }]
          : [],
        prompt: REALTIME_PROMPT,
        transport: { type: "webrtc", sdp: offerSdp },
      });

      const outcome = await connection.waitFor(
        (message) =>
          message.method === "thread/realtime/sdp" ||
          message.method === "thread/realtime/error" ||
          message.method === "thread/realtime/closed",
        "WebRTC SDP answer",
        45_000,
      );
      if (outcome.method !== "thread/realtime/sdp") {
        throw new Error(
          outcome.params?.message ??
          outcome.params?.reason ??
          "Codex realtime closed before returning a WebRTC answer.",
        );
      }
      const answerSdp = String(outcome.params?.sdp ?? "");
      if (!answerSdp) throw new Error("Codex realtime returned an empty WebRTC answer.");
      this.publish({ sessionId, status: "connected" });
      diagnosticLog("voice.realtime", "session.answer.received", {
        sessionId,
        threadId: this.threadId,
        sdp: answerSdp,
      });
      return { sessionId, answerSdp };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnosticLog("voice.realtime", "session.start.failed", {
        sessionId,
        error: message,
      });
      this.publish({ sessionId, status: "failed", error: message });
      await this.stop("voice startup failed", false);
      throw error;
    }
  }

  async stop(reason = "requested", publishClosed = true): Promise<void> {
    const connection = this.connection;
    const threadId = this.threadId;
    const sessionId = this.sessionId;
    if (!connection) return;
    diagnosticLog("voice.realtime", "session.stop.requested", {
      sessionId,
      threadId,
      reason,
    });
    if (threadId && connection.running) {
      try {
        await Promise.race([
          connection.request("thread/realtime/stop", { threadId }, 5_000),
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ]);
      } catch (error) {
        diagnosticLog("voice.realtime", "session.stop.rpc_failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.removeNotificationListener?.();
    this.removeNotificationListener = null;
    connection.stop(reason);
    if (publishClosed && sessionId) {
      this.publish({ sessionId, status: "closed", reason });
    }
    this.connection = null;
    this.threadId = null;
    this.sessionId = null;
    this.emit = null;
    this.transcripts = { user: "", assistant: "" };
    this.lastPublishedStatus = null;
    this.ownerStopInProgress = false;
    this.lastUserTranscriptWasStop = false;
    this.lastSyncedTask = null;
    this.lastProgressSyncAt = 0;
  }

  async syncTask(task: TaskSnapshot): Promise<void> {
    this.latestTask = structuredClone(task);
    const previous = this.lastSyncedTask;
    const statusChanged =
      !previous ||
      previous.id !== task.id ||
      previous.status !== task.status;
    const progressChanged =
      !previous ||
      previous.id !== task.id ||
      previous.progress.length !== task.progress.length;
    const progressDue =
      task.status === "running" &&
      progressChanged &&
      Date.now() - this.lastProgressSyncAt >= 15_000;
    this.lastSyncedTask = structuredClone(task);
    if (
      statusChanged &&
      ["completed", "failed", "cancelled"].includes(task.status)
    ) {
      this.lastTerminalTaskAt = Date.now();
    }
    if (!this.active || (!statusChanged && !progressDue)) return;
    if (progressDue) this.lastProgressSyncAt = Date.now();

    const connection = this.connection;
    const threadId = this.threadId;
    if (!connection || !threadId) return;
    diagnosticLog("voice.realtime", "task_state.sync", {
      taskId: task.id,
      status: task.status,
      statusChanged,
      progressDue,
      progressCount: task.progress.length,
    });
    try {
      await connection.request("thread/realtime/appendText", {
        threadId,
        role: "developer",
        text: taskSnapshotToRealtimeContext(task),
      });
      const speech = taskStatusSpeech(task, previous?.status);
      if (speech) {
        await connection.request("thread/realtime/appendSpeech", {
          threadId,
          text: speech,
        });
      }
    } catch (error) {
      diagnosticLog("voice.realtime", "task_state.sync_failed", {
        taskId: task.id,
        status: task.status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleNotification(message: JsonRpcMessage) {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    const params = message.params ?? {};
    if (message.method === "thread/realtime/transcript/delta") {
      const role = params.role === "user" ? "user" : params.role === "assistant" ? "assistant" : null;
      if (!role) return;
      this.transcripts[role] += String(params.delta ?? "");
      this.publish({
        sessionId,
        status: role === "user" ? "listening" : "speaking",
        role,
        transcript: this.transcripts[role],
      });
    } else if (message.method === "thread/realtime/transcript/done") {
      const role = params.role === "user" ? "user" : params.role === "assistant" ? "assistant" : null;
      if (!role) return;
      const transcript = String(params.text ?? this.transcripts[role]).trim();
      this.transcripts[role] = transcript;
      this.publish({
        sessionId,
        status: role === "user" ? "thinking" : "connected",
        role,
        transcript,
      });
      if (role === "user" && isOwnerStopTranscript(transcript)) {
        this.lastUserTranscriptWasStop = true;
        this.enforceOwnerStop(sessionId);
        return;
      }
      if (role === "user") this.lastUserTranscriptWasStop = false;
      if (role === "assistant") this.transcripts.assistant = "";
      if (role === "user") this.transcripts.user = "";
    } else if (message.method === "thread/realtime/outputAudio/delta") {
      this.publish({ sessionId, status: "speaking" });
    } else if (message.method === "thread/realtime/error") {
      const error = String(params.message ?? "Codex realtime voice failed.");
      this.publish({ sessionId, status: "failed", error });
      this.clearConnection("upstream realtime error");
    } else if (message.method === "thread/realtime/closed") {
      this.publish({
        sessionId,
        status: "closed",
        reason: String(params.reason ?? "Codex realtime voice closed."),
      });
      this.clearConnection("upstream realtime closed");
    }
  }

  private async handleServerRequest(
    message: JsonRpcMessage,
  ): Promise<AppServerRequestReply> {
    if (message.method !== "item/tool/call") {
      diagnosticLog("voice.realtime", "tool.denied", {
        method: message.method,
        tool: message.params?.tool,
      });
      return {
        error: {
          code: -32601,
          message: "Realtime conversation exposes only BMO Task controls.",
        },
      };
    }
    if (message.params?.tool === "get_task_state") {
      const task = this.readCurrentTask() ?? this.latestTask;
      diagnosticLog("voice.realtime", "task_state.read", {
        taskId: task?.id,
        status: task?.status,
      });
      return {
        result: {
          success: true,
          contentItems: [{
            type: "inputText",
            text: task
              ? taskSnapshotToRealtimeContext(task)
              : "[AUTHORITATIVE TASK STATE]\nNo Task exists.",
          }],
        },
      };
    }
    if (message.params?.tool !== "control_computer") {
      return {
        error: {
          code: -32601,
          message: "Unknown BMO Task control.",
        },
      };
    }
    if (this.lastUserTranscriptWasStop || this.ownerStopInProgress) {
      diagnosticLog("voice.realtime", "computer_control.blocked_by_stop", {
        tool: message.params?.tool,
      });
      return {
        result: {
          success: false,
          contentItems: [{
            type: "inputText",
            text: "The owner just said Stop. Do not create, retry, or continue a Task from this turn.",
          }],
        },
      };
    }
    const rawArguments = message.params.arguments;
    const args =
      typeof rawArguments === "string"
        ? JSON.parse(rawArguments) as { goal?: unknown; kind?: unknown; retry?: unknown }
        : rawArguments as { goal?: unknown; kind?: unknown; retry?: unknown };
    const goal = typeof args?.goal === "string" ? args.goal.trim() : "";
    const rawKind = typeof args?.kind === "string" ? args.kind : "general";
    const kind = (["general", "coding", "computer", "browser"].includes(rawKind)
      ? rawKind
      : "general") as "general" | "coding" | "computer" | "browser";
    const explicitRetry = args?.retry === true;
    if (!goal || goal.length > 20_000) {
      return {
        result: {
          success: false,
          contentItems: [{
            type: "inputText",
            text: "The Task goal was empty or too long.",
          }],
        },
      };
    }
    const latest = this.readCurrentTask() ?? this.latestTask;
    const duplicateWithinGrace =
      !!latest &&
      ["completed", "failed", "cancelled"].includes(latest.status) &&
      latest.goal.trim().toLowerCase() === goal.toLowerCase() &&
      Date.now() - this.lastTerminalTaskAt < 60_000;
    if (duplicateWithinGrace && !explicitRetry) {
      diagnosticLog("voice.realtime", "computer_control.duplicate_suppressed", {
        taskId: latest.id,
        status: latest.status,
      });
      return {
        result: {
          success: true,
          contentItems: [{
            type: "inputText",
            text: `${taskSnapshotToRealtimeContext(latest)}\nA matching Task just finished. Do not create another one unless the owner explicitly asks to retry.`,
          }],
        },
      };
    }
    const task = await this.startComputerTask(goal, kind);
    this.latestTask = structuredClone(task);
    diagnosticLog("voice.realtime", "computer_control.started", {
      taskId: task.id,
      goal: textMeta(goal),
      kind,
    });
    return {
      result: {
        success: true,
        contentItems: [{
          type: "inputText",
          text: `${taskSnapshotToRealtimeContext(task)}\nThe BMO app is showing the approval request now. Once approved, execution starts automatically.`,
        }],
      },
    };
  }

  private enforceOwnerStop(sessionId: string) {
    if (this.ownerStopInProgress) return;
    this.ownerStopInProgress = true;
    diagnosticLog("voice.realtime", "owner_stop.enforced", { sessionId });
    void this.stopActiveTask()
      .then(async (stopped) => {
        diagnosticLog("voice.realtime", "owner_stop.task_cancelled", {
          sessionId,
          stopped,
        });
        const connection = this.connection;
        const threadId = this.threadId;
        if (!stopped && connection?.running && threadId) {
          await connection.request("thread/realtime/appendSpeech", {
            threadId,
            text: "There isn’t an active task to stop. I’m still listening.",
          });
        }
        if (this.sessionId === sessionId) {
          this.publish({ sessionId, status: "connected" });
        }
      })
      .catch((error) =>
        diagnosticLog("voice.realtime", "owner_stop.task_cancel_failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        }))
      .finally(() => {
        this.ownerStopInProgress = false;
      });
  }

  private clearConnection(reason: string) {
    this.removeNotificationListener?.();
    this.removeNotificationListener = null;
    this.connection?.stop(reason);
    this.connection = null;
    this.threadId = null;
    this.sessionId = null;
    this.emit = null;
    this.transcripts = { user: "", assistant: "" };
    this.lastPublishedStatus = null;
    this.ownerStopInProgress = false;
    this.lastUserTranscriptWasStop = false;
    this.lastSyncedTask = null;
    this.lastProgressSyncAt = 0;
  }

  private publish(update: RealtimeVoiceUpdate) {
    const statusOnly = !update.transcript && !update.error && !update.reason;
    if (statusOnly && this.lastPublishedStatus === update.status) return;
    this.lastPublishedStatus = update.status;
    diagnosticLog("voice.realtime", "session.update", {
      sessionId: update.sessionId,
      status: update.status,
      role: update.role,
      transcript: update.transcript ? textMeta(update.transcript) : undefined,
      error: update.error,
      reason: update.reason,
    });
    this.emit?.(update);
  }
}
