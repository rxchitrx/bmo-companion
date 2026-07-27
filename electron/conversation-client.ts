import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { diagnosticLog, textMeta } from "./diagnostics.js";

export interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code?: number; message?: string };
}

export type ConversationStatus =
  | "connecting"
  | "sending"
  | "responding"
  | "completed"
  | "degraded"
  | "failed";

export interface ConversationUpdate {
  requestId: string;
  status: ConversationStatus;
  transport: "realtime" | "codex-turn";
  assistantText?: string;
  warning?: string;
  error?: string;
}

type NotificationWaiter = {
  label: string;
  predicate: (message: JsonRpcMessage) => boolean;
  resolve: (message: JsonRpcMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class AppServerConnection {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, {
    method: string;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private notifications: JsonRpcMessage[] = [];
  private waiters = new Set<NotificationWaiter>();
  private listeners = new Set<(message: JsonRpcMessage) => void>();

  constructor(private readonly name: string) {}

  get running() { return this.child != null; }

  onNotification(listener: (message: JsonRpcMessage) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start() {
    if (this.child) return;
    const codex = process.env.CODEX_CLI_PATH || "/Applications/ChatGPT.app/Contents/Resources/codex";
    if (!existsSync(codex)) throw new Error(`Codex executable not found: ${codex}`);
    diagnosticLog(this.name, "process.spawn.requested", { binaryExists: true });
    const child = spawn(
      codex,
      ["--enable", "realtime_conversation", "app-server", "--listen", "stdio://"],
      {
        cwd: process.cwd(),
        env: { ...process.env },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        diagnosticLog(this.name, "process.stderr", { line });
      }
    });
    child.once("spawn", () => diagnosticLog(this.name, "process.spawned", { pid: child.pid }));
    child.once("exit", (code, signal) => this.handleExit(code, signal));
    child.once("error", (error) => this.handleExit(null, null, error));

    await this.request("initialize", {
      clientInfo: { name: "bmo-companion", title: "BMO Companion", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized" });
    const account = await this.request("account/read", { refreshToken: false });
    diagnosticLog(this.name, "protocol.initialized", {
      accountType: account?.account?.type ?? account?.authMode ?? "unknown",
    });
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 45_000) {
    if (!this.child) return Promise.reject(new Error("Codex app-server is not running."));
    const id = this.nextId++;
    diagnosticLog(this.name, "rpc.request", {
      id,
      method,
      paramKeys: Object.keys(params),
      ...(typeof params.text === "string" ? { text: params.text } : {}),
      ...(typeof (params.transport as any)?.sdp === "string"
        ? { sdp: (params.transport as any).sdp }
        : {}),
    });
    this.send({ id, method, params });
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        diagnosticLog(this.name, "rpc.timeout", { id, method, timeoutMs });
        reject(new Error(`${method} timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
    });
  }

  waitFor(
    predicate: (message: JsonRpcMessage) => boolean,
    label: string,
    timeoutMs = 45_000,
  ) {
    const existingIndex = this.notifications.findIndex(predicate);
    if (existingIndex >= 0) {
      const [existing] = this.notifications.splice(existingIndex, 1);
      return Promise.resolve(existing);
    }
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const waiter: NotificationWaiter = {
        label,
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          diagnosticLog(this.name, "notification.timeout", { label, timeoutMs });
          reject(new Error(`Timed out waiting for ${label}.`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  stop(reason: string) {
    const child = this.child;
    if (!child) return;
    diagnosticLog(this.name, "process.stop", { reason, pid: child.pid });
    this.child = null;
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Codex app-server stopped: ${reason}`));
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`Codex app-server stopped: ${reason}`));
    }
    this.waiters.clear();
    this.notifications = [];
  }

  private send(message: JsonRpcMessage) {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consume(chunk: string) {
    this.buffer += chunk;
    while (this.buffer.includes("\n")) {
      const newline = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.handle(JSON.parse(line) as JsonRpcMessage);
      } catch {
        diagnosticLog(this.name, "protocol.unparsed_line", { chars: line.length });
      }
    }
  }

  private handle(message: JsonRpcMessage) {
    if (message.id != null && message.method) {
      diagnosticLog(this.name, "rpc.server_request.denied", {
        id: message.id,
        method: message.method,
      });
      this.send({
        id: message.id,
        error: { code: -32601, message: "Conversation transport cannot approve actions." },
      });
      return;
    }
    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        diagnosticLog(this.name, "rpc.orphan_response", { id: message.id });
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        diagnosticLog(this.name, "rpc.response.error", {
          id: message.id,
          method: pending.method,
          code: message.error.code,
          error: message.error.message,
        });
        pending.reject(new Error(message.error.message ?? `${pending.method} failed.`));
      } else {
        diagnosticLog(this.name, "rpc.response.ok", {
          id: message.id,
          method: pending.method,
          resultKeys: Object.keys(message.result ?? {}),
        });
        pending.resolve(message.result);
      }
      return;
    }
    if (!message.method) return;
    this.notifications.push(message);
    if (this.notifications.length > 200) this.notifications.shift();
    const params = message.params ?? {};
    diagnosticLog(this.name, "rpc.notification", {
      method: message.method,
      role: params.role,
      status: params.turn?.status ?? params.status,
      delta: typeof params.delta === "string" ? params.delta : undefined,
      text: typeof params.text === "string" ? params.text : undefined,
      error: params.message,
      reason: params.reason,
      itemType: params.item?.type,
      itemStatus: params.item?.status,
    });
    for (const listener of this.listeners) listener(message);
    let consumed = false;
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(message)) continue;
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      consumed = true;
    }
    if (consumed) {
      const index = this.notifications.indexOf(message);
      if (index >= 0) this.notifications.splice(index, 1);
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null, error?: Error) {
    if (!this.child && !error) return;
    this.child = null;
    const failure = error ?? new Error(`Codex app-server exited: code=${code}, signal=${signal}`);
    diagnosticLog(this.name, "process.exited", {
      code,
      signal,
      error: failure.message,
    });
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(failure);
    }
    this.waiters.clear();
  }
}

export class CodexConversationClient {
  private fallback: AppServerConnection | null = null;
  private fallbackThreadId: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  send(
    text: string,
    emit: (update: ConversationUpdate) => void,
  ): Promise<ConversationUpdate> {
    const requestId = randomUUID();
    const run = this.queue.then(() => this.sendInternal(requestId, text, emit));
    this.queue = run.catch(() => undefined);
    return run;
  }

  stop() {
    this.fallback?.stop("application shutdown");
    this.fallback = null;
  }

  private async sendInternal(
    requestId: string,
    text: string,
    emit: (update: ConversationUpdate) => void,
  ) {
    diagnosticLog("conversation", "request.accepted", {
      requestId,
      text: textMeta(text),
      transport: "codex-turn",
    });
    return this.sendFallback(requestId, text, emit, true);
  }

  private async ensureFallback(requestId: string, emit: (update: ConversationUpdate) => void) {
    if (this.fallback?.running && this.fallbackThreadId) return;
    emit({ requestId, status: "connecting", transport: "codex-turn" });
    const connection = new AppServerConnection("conversation.fallback");
    this.fallback = connection;
    await connection.start();
    const thread = await connection.request("thread/start", {
      cwd: process.cwd(),
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    this.fallbackThreadId = thread.thread.id;
    diagnosticLog("conversation", "fallback.ready", {
      requestId,
      threadId: this.fallbackThreadId,
    });
  }

  private async sendFallback(
    requestId: string,
    text: string,
    emit: (update: ConversationUpdate) => void,
    allowReconnect: boolean,
  ): Promise<ConversationUpdate> {
    try {
      await this.ensureFallback(requestId, emit);
      const connection = this.fallback!;
      let assistantText = "";
      let failedItem = false;
      const remove = connection.onNotification((message) => {
        if (message.method === "item/agentMessage/delta") {
          assistantText += String(message.params?.delta ?? "");
          emit({ requestId, status: "responding", transport: "codex-turn", assistantText });
        } else if (message.method === "item/completed") {
          const item = message.params?.item;
          if (item?.type === "agentMessage" && item.text) {
            assistantText = String(item.text);
            emit({ requestId, status: "responding", transport: "codex-turn", assistantText });
          }
          if (item?.status === "failed") failedItem = true;
        }
      });
      try {
        emit({ requestId, status: "sending", transport: "codex-turn" });
        await connection.request("turn/start", {
          threadId: this.fallbackThreadId,
          input: [{
            type: "text",
            text: `Respond as BMO, Rachit's warm and concise personal companion. This is conversation only: do not use tools, inspect files, or operate the computer. If the message needs an external action, explain that it should be started as an approved Task.\n\nUser message: ${text}`,
          }],
        });
        const outcome = await connection.waitFor(
          (message) => message.method === "turn/completed",
          "Codex conversation turn",
        );
        const status = outcome.params?.turn?.status;
        if (status !== "completed" || failedItem || !assistantText.trim()) {
          throw new Error(`Codex conversation ended with status ${status ?? "unknown"}.`);
        }
        assistantText = assistantText.trim();
        const completed: ConversationUpdate = {
          requestId,
          status: "completed",
          transport: "codex-turn",
          assistantText,
        };
        emit(completed);
        diagnosticLog("conversation", "request.completed", {
          requestId,
          transport: "codex-turn",
          assistantText: textMeta(assistantText),
        });
        return completed;
      } finally {
        remove();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Codex conversation failed.";
      diagnosticLog("conversation", "fallback.error", {
        requestId,
        error: message,
        allowReconnect,
      });
      if (allowReconnect) {
        this.resetFallback("reconnecting after fallback failure");
        emit({
          requestId,
          status: "connecting",
          transport: "codex-turn",
          warning: "Conversation worker disconnected; reconnecting once.",
        });
        return this.sendFallback(requestId, text, emit, false);
      }
      const failed: ConversationUpdate = {
        requestId,
        status: "failed",
        transport: "codex-turn",
        error: message,
      };
      emit(failed);
      throw error;
    }
  }

  private resetFallback(reason: string) {
    this.fallback?.stop(reason);
    this.fallback = null;
    this.fallbackThreadId = null;
  }
}
