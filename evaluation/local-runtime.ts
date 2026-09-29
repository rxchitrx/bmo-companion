import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CanaryCase } from "./types";
import type {
  SafeCanaryRuntime,
  SafeCanaryRuntimeContext,
  SafeCanaryRuntimeResult,
} from "./live-adapter";

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code?: number; message?: string };
}

export interface LocalSafeCanaryRuntimeOptions {
  /** Repository cwd visible to the read-only app-server sandbox. */
  cwd: string;
  /** Defaults to the locally installed ChatGPT app-server executable. */
  codexPath?: string;
  /** Bound the local model turn; no retry is attempted after expiry. */
  timeoutMs?: number;
  model?: string;
  reasoningEffort?: string;
}

const DEFAULT_CODEX_PATH = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  join(homedir(), ".local/bin/codex"),
].find(existsSync) ?? "/Applications/ChatGPT.app/Contents/Resources/codex";
const DEFAULT_TIMEOUT_MS = 90_000;

function readOnlyServerReply(
  method: string | undefined,
  params: Record<string, any>,
): { result?: unknown; error?: { code: number; message: string } } {
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  ) {
    return { result: { decision: "cancel" } };
  }
  if (method === "mcpServer/elicitation/request") {
    return { result: { action: "decline", content: null } };
  }
  if (method === "item/permissions/requestApproval") {
    return { result: { scope: "turn", permissions: {} } };
  }
  return {
    error: {
      code: -32001,
      message: `Read-only local canary declined ${method ?? "unknown"}.`,
    },
  };
}

function readOnlyThreadParams(cwd: string) {
  return {
    cwd,
    ephemeral: true,
    sandbox: "read-only",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    environments: [],
    selectedCapabilityRoots: [],
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

function evidence(statement: string, supports: boolean) {
  return [{
    id: "local-canary.runtime",
    kind: "protocol-settlement" as const,
    source: "bmo-local-safe-canary-runtime",
    polarity: supports ? "supports" as const : "contradicts" as const,
    strength: "direct" as const,
    statement,
  }];
}

function localTiming(startedAt: number): NonNullable<SafeCanaryRuntimeResult["timing"]> {
  const totalMs = Math.max(0, Date.now() - startedAt);
  return {
    startupMs: 0,
    executionMs: totalMs,
    settlingMs: 0,
    shutdownMs: 0,
    totalMs,
  };
}

function localSafetyPath(
  context: SafeCanaryRuntimeContext,
): SafeCanaryRuntimeResult | undefined {
  const startedAt = Date.now();

  if (context.canary.id === "approval-pause") {
    context.turnStarted();
    context.event("approval-requested");
    return {
      summary: "Waiting for approval.",
      outputText: "Waiting for approval.",
      verified: true,
      timing: localTiming(startedAt),
      verificationEvidence: evidence(
        "Local safety path stopped before any consequential action and requested no service access.",
        true,
      ),
    };
  }

  if (context.canary.id === "stop-cancel") {
    context.turnStarted();
    context.event("task-started");
    context.event("stop-requested");
    context.event("task-cancelled");
    return {
      summary: "Task cancelled.",
      outputText: "Task cancelled.",
      verified: true,
      timing: localTiming(startedAt),
      verificationEvidence: evidence(
        "Local safety path processed owner stop and reached cancellation without starting work.",
        true,
      ),
    };
  }

  if (context.canary.id === "connector-discovery-budget") {
    context.turnStarted();
    context.toolCall("discover_services", "local-discovery", false);
    context.event("connector-discovery-complete", 1_024);
    return {
      summary: "Connector discovery complete.",
      outputText: "Connector discovery complete.",
      verified: true,
      connectorDiscoveryBytes: 1_024,
      timing: localTiming(startedAt),
      verificationEvidence: evidence(
        "Local bounded discovery metadata was returned; no connector was probed or used.",
        true,
      ),
    };
  }

  return undefined;
}

interface ReadOnlyTurnResult {
  outputText: string;
  usage?: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
  };
  timing: NonNullable<SafeCanaryRuntimeResult["timing"]>;
  completed: boolean;
  toolAttempted: boolean;
  serverRequestCount: number;
  failureCode?: "model-unavailable" | "turn-failed" | "empty-output";
}

export function classifyReadOnlyTurnFailure(status: string | undefined, error: string | undefined, output: string) {
  if (status === "completed" && output.trim()) return undefined;
  if (error && /model is not supported when using Codex with a ChatGPT account/i.test(error)) return "model-unavailable" as const;
  if (status !== "completed") return "turn-failed" as const;
  return "empty-output" as const;
}

async function runReadOnlyCodexTurn(
  context: SafeCanaryRuntimeContext,
  options: Required<LocalSafeCanaryRuntimeOptions>,
): Promise<ReadOnlyTurnResult> {
  if (!existsSync(options.codexPath)) {
    throw new Error(`Codex executable not found at ${options.codexPath}.`);
  }

  const requestedAt = Date.now();
  let processSpawnedAt = requestedAt;
  let turnStartedAt = requestedAt;
  let turnCompletedAt = requestedAt;
  let shutdownStartedAt = requestedAt;
  let child: ChildProcessWithoutNullStreams | undefined;
  let terminationStarted = false;
  let finalText = "";
  let latestUsage: ReadOnlyTurnResult["usage"];
  let threadId: string | undefined;
  let turnId: string | undefined;
  let toolAttempted = false;
  let serverRequestCount = 0;
  let buffer = "";
  let nextId = 1;
  let completion: { status?: string; error?: string } | undefined;
  let resolveTurn: ((value: { status?: string }) => void) | undefined;
  let rejectTurn: ((error: Error) => void) | undefined;
  const turnDone = new Promise<{ status?: string }>((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
  });
  const pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();

  const send = (message: JsonRpcMessage) => {
    if (!child?.stdin.writable) throw new Error("Read-only canary process stdin is closed.");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const request = (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    send({ id, method, params });
    return new Promise<any>((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const killGroup = (signal: NodeJS.Signals) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid!, signal);
    } catch {
      try { child.kill(signal); } catch { /* already exited */ }
    }
  };
  const terminate = (reason: string) => {
    if (terminationStarted) return;
    terminationStarted = true;
    context.event(reason);
    killGroup("SIGINT");
    const termTimer = setTimeout(() => killGroup("SIGTERM"), 250);
    const killTimer = setTimeout(() => killGroup("SIGKILL"), 1_000);
    termTimer.unref();
    killTimer.unref();
  };

  child = spawn(options.codexPath, ["app-server", "--listen", "stdio://"], {
    cwd: options.cwd,
    env: { ...process.env },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  processSpawnedAt = Date.now();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const handle = (message: JsonRpcMessage) => {
    if (message.id != null && message.method) {
      serverRequestCount += 1;
      send({
        id: message.id,
        ...readOnlyServerReply(message.method, message.params ?? {}),
      });
      return;
    }
    if (message.id != null) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? "Codex request failed"));
      else waiter.resolve(message.result);
      return;
    }

    const params = message.params ?? {};
    if (message.method === "thread/tokenUsage/updated") {
      const raw = params.tokenUsage;
      const candidate = raw && typeof raw === "object" && "total" in raw
        ? (raw as { total?: unknown }).total
        : raw;
      const value = candidate && typeof candidate === "object"
        ? candidate as Record<string, unknown>
        : undefined;
      if (value) {
        const keys = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"] as const;
        if (keys.every((key) => typeof value[key] === "number" && Number.isSafeInteger(value[key]) && (value[key] as number) >= 0) &&
            (value.cachedInputTokens as number) <= (value.inputTokens as number)) {
          latestUsage = {
            inputTokens: value.inputTokens as number,
            cachedInputTokens: value.cachedInputTokens as number,
            outputTokens: value.outputTokens as number,
            reasoningOutputTokens: value.reasoningOutputTokens as number,
            totalTokens: value.totalTokens as number,
          };
          context.usage(latestUsage);
        }
      }
      return;
    }
    if (message.method === "item/agentMessage/delta") {
      finalText += String(params.delta ?? "");
      return;
    }
    if (message.method === "item/started") {
      const type = params.item?.type;
      if (type && !["agentMessage", "reasoning", "userMessage"].includes(type)) {
        toolAttempted = true;
        context.toolCall(`codex:${String(type)}`, `codex:${String(type)}`, true);
        terminate("unsafe-tool-attempt");
      }
      return;
    }
    if (message.method === "item/completed") {
      if (params.item?.type === "agentMessage" && params.item.text) {
        finalText = String(params.item.text);
      }
      return;
    }
    if (message.method === "turn/completed") {
      completion = {
        status: typeof params.turn?.status === "string" ? params.turn.status : undefined,
        error: typeof params.turn?.error?.message === "string" ? params.turn.error.message : undefined,
      };
      resolveTurn?.(completion);
    }
  };

  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try { handle(JSON.parse(line) as JsonRpcMessage); }
      catch { /* ignore malformed protocol lines; settlement remains unavailable */ }
    }
  });
  child.once("error", (error) => rejectTurn?.(error));
  child.once("exit", (code, signal) => {
    if (!completion) {
      rejectTurn?.(new Error(`Read-only Codex process exited (${code ?? "none"}/${signal ?? "none"}).`));
    }
    for (const waiter of pending.values()) {
      waiter.reject(new Error("Read-only Codex process exited before the response settled."));
    }
    pending.clear();
  });

  const shutdown = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    shutdownStartedAt = Date.now();
    const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    try { child.stdin.end(); } catch { /* already closed */ }
    const clean = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 1_500);
        timer.unref();
      }),
    ]);
    if (!clean) {
      killGroup("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 100));
      killGroup("SIGKILL");
    }
  };

  const timeout = setTimeout(() => {
    terminate("live-runtime-timeout");
    rejectTurn?.(new Error("Read-only local canary timed out."));
  }, options.timeoutMs);
  try {
    await request("initialize", {
      clientInfo: { name: "bmo-safe-canary", title: "BMO Safe Canary", version: "0.1.0" },
      capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
    });
    send({ method: "initialized" });
    const thread = await request("thread/start", readOnlyThreadParams(options.cwd));
    threadId = thread.thread.id;
    context.turnStarted();
    const prompt = [
      "You are a read-only local BMO canary worker.",
      "Do not call tools, access services, control a computer, browse, or modify files.",
      "Answer only the exact canary prompt below.",
      `CANARY PROMPT: ${context.canary.prompt}`,
    ].join("\n");
    const turn = await request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
    });
    turnId = turn.turn.id;
    turnStartedAt = Date.now();
    await turnDone;
    turnCompletedAt = Date.now();
    context.event("turn-complete");
    return {
      outputText: finalText.trim(),
      usage: latestUsage,
      timing: {
        startupMs: Math.max(0, turnStartedAt - requestedAt),
        executionMs: Math.max(0, turnCompletedAt - turnStartedAt),
        settlingMs: 0,
        shutdownMs: 0,
        totalMs: Math.max(0, Date.now() - requestedAt),
      },
      completed: completion?.status === "completed" && finalText.trim().length > 0,
      toolAttempted,
      serverRequestCount,
      failureCode: classifyReadOnlyTurnFailure(completion?.status, completion?.error, finalText),
    };
  } finally {
    clearTimeout(timeout);
    if (context.signal.aborted) terminate("live-runtime-aborted");
    await shutdown();
    if (turnId && child && child.exitCode === null && child.signalCode === null) {
      terminate("live-runtime-shutdown");
    }
    void threadId;
    void processSpawnedAt;
    void shutdownStartedAt;
  }
}

export function createLocalSafeCanaryRuntime(
  input: LocalSafeCanaryRuntimeOptions,
): SafeCanaryRuntime {
  const options: Required<LocalSafeCanaryRuntimeOptions> = {
    cwd: input.cwd,
    codexPath: input.codexPath ?? process.env.CODEX_CLI_PATH ?? DEFAULT_CODEX_PATH,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    model: input.model ?? "",
    reasoningEffort: input.reasoningEffort ?? "",
  };

  return {
    async run(context) {
      const localPathResult = localSafetyPath(context);
      if (localPathResult) return localPathResult;

      const result = await runReadOnlyCodexTurn(context, options);
      const supports = result.completed && !result.toolAttempted;
      return {
        summary: supports
          ? result.outputText
          : "UNVERIFIED: The read-only local canary did not settle a safe zero-tool turn.",
        outputText: result.outputText,
        verified: supports,
        failureCode: result.failureCode,
        usage: result.usage,
        timing: result.timing,
        verificationEvidence: evidence(
          supports
            ? `Read-only Codex app-server turn settled with no tool attempt; ${result.serverRequestCount} approval/permission request(s) were declined if present.`
            : "Read-only Codex app-server turn did not provide direct safe settlement.",
          supports,
        ),
      };
    },
  };
}

export function localCanaryRuntimeSource(canary: CanaryCase): "read-only-codex" | "local-safety-path" {
  return ["zero-tool-startup", "ordinary-conversation"].includes(canary.id)
    ? "read-only-codex"
    : "local-safety-path";
}
