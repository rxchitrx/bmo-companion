import { randomUUID } from "node:crypto";
import {
  AppServerConnection,
  type JsonRpcMessage,
} from "./conversation-client.js";
import { diagnosticLog, textMeta } from "./diagnostics.js";

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
  "You may discuss and coordinate work, but do not perform consequential computer or external-service actions without the separate approved Task flow.",
  "If the user requests an action, explain what you understood and that BMO can start it as a Task.",
].join(" ");

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
    this.publish({ sessionId, status: "connecting" });
    diagnosticLog("voice.realtime", "session.start.requested", {
      sessionId,
      sdp: offerSdp,
      version: "v3",
      outputModality: "audio",
    });

    const connection = new AppServerConnection("voice.realtime");
    this.connection = connection;
    this.removeNotificationListener = connection.onNotification((message) =>
      this.handleNotification(message));

    try {
      await connection.start();
      const thread = await connection.request("thread/start", {
        cwd: process.cwd(),
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "read-only",
      });
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
