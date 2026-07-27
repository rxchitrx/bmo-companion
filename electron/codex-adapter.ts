import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import type {
  AccountUsage,
  ExecutionResult,
  RecoveryObserver,
  TaskExecutor,
  TaskSnapshot,
  TokenUsage,
} from "./task-runtime.js";
import { diagnosticLog, textMeta } from "./diagnostics.js";
import { ComputerUseHealth } from "./computer-use-health.js";

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code?: number; message?: string };
}

export function normalizeTaskTokenUsage(value: unknown): TokenUsage | undefined {
  const candidate = (
    value &&
    typeof value === "object" &&
    "total" in value &&
    (value as { total?: unknown }).total
  ) || value;
  if (!candidate || typeof candidate !== "object") return undefined;
  const usage = candidate as Record<string, unknown>;
  const number = (key: string) =>
    typeof usage[key] === "number" && Number.isFinite(usage[key])
      ? Math.max(0, Math.round(usage[key] as number))
      : 0;
  const normalized: TokenUsage = {
    inputTokens: number("inputTokens"),
    cachedInputTokens: number("cachedInputTokens"),
    outputTokens: number("outputTokens"),
    reasoningOutputTokens: number("reasoningOutputTokens"),
    totalTokens: number("totalTokens"),
  };
  return normalized.totalTokens > 0 ? normalized : undefined;
}

export function normalizeAccountUsage(value: unknown): AccountUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const limits = value as Record<string, any>;
  const percentage = (window: unknown) => {
    const used = (window as { usedPercent?: unknown } | null)?.usedPercent;
    return typeof used === "number" && Number.isFinite(used)
      ? Math.min(100, Math.max(0, Math.round(used)))
      : undefined;
  };
  const reset = (window: unknown) => {
    const resetsAt = (window as { resetsAt?: unknown } | null)?.resetsAt;
    return typeof resetsAt === "number" && Number.isFinite(resetsAt)
      ? Math.round(resetsAt)
      : undefined;
  };
  const normalized: AccountUsage = {
    planType:
      typeof limits.planType === "string" ? limits.planType : undefined,
    primaryUsedPercent: percentage(limits.primary),
    primaryResetsAt: reset(limits.primary),
    secondaryUsedPercent: percentage(limits.secondary),
    secondaryResetsAt: reset(limits.secondary),
  };
  return Object.values(normalized).some((entry) => entry !== undefined)
    ? normalized
    : undefined;
}

function itemDiagnostic(item: Record<string, any> | undefined) {
  if (!item) return undefined;
  const command = Array.isArray(item.command)
    ? item.command.join(" ")
    : typeof item.command === "string"
      ? item.command
      : "";
  return {
    id: item.id,
    type: item.type,
    status: item.status,
    server: item.server,
    tool: item.tool ?? item.name,
    command: command ? textMeta(command) : undefined,
    exitCode: item.exitCode,
    errorCode: item.error?.code,
    errorMessage: item.error?.message,
  };
}

export function createTaskThreadParams(cwd: string) {
  return {
    cwd,
    ephemeral: true,
    approvalPolicy: {
      granular: {
        mcp_elicitations: true,
        request_permissions: true,
        rules: true,
        sandbox_approval: true,
        skill_approval: true,
      },
    },
    approvalsReviewer: "user",
    sandbox: "workspace-write",
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

export function taskServerRequestReply(
  method: string | undefined,
  params: Record<string, any>,
  authorityActive: boolean,
): { result?: unknown; error?: { code: number; message: string } } {
  if (!authorityActive) {
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
      error: { code: -32001, message: "Task authority has been revoked." },
    };
  }

  if (method === "item/permissions/requestApproval") {
    return {
      result: { scope: "turn", permissions: params.permissions ?? {} },
    };
  }
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  ) {
    return { result: { decision: "accept" } };
  }
  if (method === "mcpServer/elicitation/request") {
    if (params.mode === "url") {
      return { result: { action: "decline", content: null } };
    }
    const schema = params.requestedSchema as {
      properties?: Record<string, any>;
    } | undefined;
    const content: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(schema?.properties ?? {})) {
      if (field.const !== undefined) content[key] = field.const;
      else if (field.default !== undefined) content[key] = field.default;
      else if (Array.isArray(field.enum) && field.enum.length) {
        content[key] = field.enum[0];
      } else if (field.type === "boolean") content[key] = true;
    }
    const isToolApproval =
      params._meta?.codex_approval_kind === "mcp_tool_call";
    return {
      result:
        isToolApproval && Object.keys(content).length === 0
          ? { action: "accept", content: {}, _meta: { persist: "session" } }
          : { action: "accept", content },
    };
  }
  return { error: { code: -32601, message: "Unsupported request" } };
}

export class CodexTaskExecutor implements TaskExecutor {
  private child: ChildProcessWithoutNullStreams | null = null;

  constructor(private readonly computerUseHealth = new ComputerUseHealth()) {}

  async execute(
    goal: string,
    signal: AbortSignal,
    progress: (message: string) => void,
    usage?: (usage: TokenUsage) => void,
    accountUsage?: (usage: AccountUsage) => void,
    execution?: {
      model: string;
      effort: string;
      kind?: "general" | "coding" | "computer" | "browser";
    },
  ): Promise<ExecutionResult> {
    const codex =
      process.env.CODEX_CLI_PATH ||
      "/Applications/ChatGPT.app/Contents/Resources/codex";
    diagnosticLog("codex.task", "execution.requested", {
      goal: textMeta(goal),
      binaryExists: existsSync(codex),
      aborted: signal.aborted,
      execution,
    });
    await this.computerUseHealth.prepare(execution?.kind, progress);
    if (!existsSync(codex)) throw new Error(`Codex executable not found: ${codex}`);

    const child = spawn(codex, ["app-server", "--listen", "stdio://"], {
      cwd: process.cwd(),
      env: { ...process.env },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    diagnosticLog("codex.task", "process.spawned", { pid: child.pid });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let nextId = 1;
    let buffer = "";
    let finalText = "";
    let failedTool = false;
    let latestUsage: TokenUsage | undefined;
    let latestAccountUsage: AccountUsage | undefined;
    let authorityRevoked = signal.aborted;
    let threadId: string | null = null;
    let turnId: string | null = null;
    let terminationStarted = false;
    const terminationTimers: NodeJS.Timeout[] = [];
    const pending = new Map<number, {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
    }>();
    let resolveTurn: ((value: any) => void) | undefined;
    let rejectTurn: ((error: Error) => void) | undefined;
    const turnDone = new Promise<any>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });

    const send = (message: JsonRpcMessage) => {
      diagnosticLog("codex.task", "rpc.send", {
        id: message.id,
        method: message.method,
        paramKeys: Object.keys(message.params ?? {}),
      });
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const request = (method: string, params: Record<string, unknown> = {}) => {
      const id = nextId++;
      send({ id, method, params });
      return new Promise<any>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    };

    const acceptServerRequest = (message: JsonRpcMessage) => {
      const params = message.params ?? {};
      const authorityActive = !authorityRevoked && !signal.aborted;
      diagnosticLog("codex.task", "rpc.server_request", {
        id: message.id,
        method: message.method,
        paramKeys: Object.keys(params),
        authorityActive,
      });
      if (!authorityActive) {
        diagnosticLog("codex.task", "rpc.server_request.revoked", {
          id: message.id,
          method: message.method,
        });
      }
      if (
        authorityActive &&
        message.method === "mcpServer/elicitation/request" &&
        params.mode === "url"
      ) {
        progress("This task needs a separate sign-in or connection decision.");
      }
      send({
        id: message.id,
        ...taskServerRequestReply(message.method, params, authorityActive),
      });
    };

    const handle = (message: JsonRpcMessage) => {
      if (message.id != null && message.method) {
        acceptServerRequest(message);
        return;
      }
      if (message.id != null) {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) {
          diagnosticLog("codex.task", "rpc.response.error", {
            id: message.id,
            error: message.error.message,
            code: message.error.code,
          });
          waiter.reject(new Error(message.error.message ?? "Codex request failed"));
        } else {
          diagnosticLog("codex.task", "rpc.response.ok", {
            id: message.id,
            resultKeys: Object.keys(message.result ?? {}),
          });
          waiter.resolve(message.result);
        }
        return;
      }
      const params = message.params ?? {};
      diagnosticLog("codex.task", "rpc.notification", {
        method: message.method,
        item: itemDiagnostic(params.item),
        turnStatus: params.turn?.status,
        delta: params.delta,
        message: params.message,
      });
      if (message.method === "thread/tokenUsage/updated") {
        latestUsage = normalizeTaskTokenUsage(params.tokenUsage);
        if (latestUsage) {
          diagnosticLog("codex.task", "usage.updated", {
            threadId: params.threadId,
            turnId: params.turnId,
            usage: latestUsage,
          });
          usage?.(latestUsage);
        }
      } else if (message.method === "account/rateLimits/updated") {
        latestAccountUsage = normalizeAccountUsage(params.rateLimits);
        if (latestAccountUsage) {
          diagnosticLog("codex.task", "account_usage.updated", {
            accountUsage: latestAccountUsage,
          });
          accountUsage?.(latestAccountUsage);
        }
      } else if (message.method === "item/agentMessage/delta") {
        finalText += String(params.delta ?? "");
      } else if (message.method === "item/started") {
        const type = params.item?.type;
        if (type && !["agentMessage", "reasoning"].includes(type)) progress(`Codex started ${type}.`);
      } else if (message.method === "item/completed") {
        const item = params.item;
        if (item?.type === "agentMessage" && item.text) finalText = item.text;
        if (item?.status === "failed") failedTool = true;
      } else if (message.method === "turn/completed") {
        resolveTurn?.(params);
      } else if (message.method === "error") {
        progress(`Codex reported: ${params.message ?? "an execution error"}`);
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
        catch { diagnosticLog("codex.task", "rpc.unparsed_line", { chars: line.length }); }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        diagnosticLog("codex.task", "process.stderr", { line });
      }
    });
    const killProcessGroup = (processSignal: NodeJS.Signals) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        process.kill(-child.pid!, processSignal);
      } catch {
        try { child.kill(processSignal); } catch { /* Process already exited. */ }
      }
    };
    const terminate = (reason: string, interrupt: boolean) => {
      if (terminationStarted) return;
      terminationStarted = true;
      authorityRevoked ||= interrupt;
      diagnosticLog("codex.task", "process.stop", {
        pid: child.pid,
        reason,
        interrupt,
        authorityRevoked,
        threadId,
        turnId,
      });
      if (interrupt && threadId && turnId && child.stdin.writable) {
        send({
          id: nextId++,
          method: "turn/interrupt",
          params: { threadId, turnId },
        });
      }
      killProcessGroup(interrupt ? "SIGINT" : "SIGTERM");
      const termTimer = setTimeout(() => killProcessGroup("SIGTERM"), 250);
      const killTimer = setTimeout(() => killProcessGroup("SIGKILL"), 1_000);
      termTimer.unref();
      killTimer.unref();
      terminationTimers.push(termTimer, killTimer);
    };
    const revokeAuthority = () => terminate("owner stop", true);
    signal.addEventListener("abort", revokeAuthority, { once: true });
    child.once("exit", (code, processSignal) => {
      for (const timer of terminationTimers) clearTimeout(timer);
      const failure = new Error(
        authorityRevoked
          ? "Task authority was revoked."
          : `Codex app-server exited: code=${code}, signal=${processSignal}`,
      );
      for (const waiter of pending.values()) waiter.reject(failure);
      pending.clear();
      rejectTurn?.(failure);
      diagnosticLog("codex.task", "process.exited", {
        code,
        signal: processSignal,
        authorityRevoked,
      });
    });
    const shutdownGracefully = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      diagnosticLog("codex.task", "process.graceful_shutdown.started", {
        pid: child.pid,
        threadId,
        turnId,
      });
      const exited = new Promise<boolean>((resolve) => {
        child.once("exit", () => resolve(true));
      });
      child.stdin.end();
      const cleanExit = await Promise.race([
        exited,
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 2_000);
          timer.unref();
        }),
      ]);
      diagnosticLog("codex.task", "process.graceful_shutdown.completed", {
        pid: child.pid,
        cleanExit,
      });
      if (!cleanExit) terminate("graceful shutdown timeout", false);
    };

    try {
      if (signal.aborted) {
        revokeAuthority();
        throw new Error("Task authority was revoked before execution started.");
      }
      progress("Connecting to the managed Codex app-server.");
      await request("initialize", {
        clientInfo: { name: "bmo-companion", title: "BMO Companion", version: "0.1.0" },
        capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
      });
      send({ method: "initialized" });
      const thread = await request(
        "thread/start",
        createTaskThreadParams(process.cwd()),
      );
      threadId = thread.thread.id;
      progress("Codex is observing the current state and choosing an approach.");
      const turn = await request("turn/start", {
        threadId,
        ...(execution
          ? { model: execution.model, effort: execution.effort }
          : {}),
        input: [{
          type: "text",
          text: `You are the execution worker for BMO, a personal Mac Companion.
Complete the goal using the most appropriate installed Codex capabilities.
Reason from the goal and current observed state; never use a predetermined
coordinate, shortcut, selector, or app-specific recipe. Recover from unexpected
state and re-observe after meaningful actions. Do not permanently delete
anything. Verify the requested real-world outcome before claiming completion.
Always inspect the current state before acting. If the goal is already satisfied,
verify it and finish without repeating the action.

When the goal depends on a visible macOS app or browser UI, use Computer Use as
the primary execution surface from the first action. Do not launch, focus, or
control GUI apps through shell commands, \`open\`, AppleScript, or other
command-execution fallbacks. Observe the live UI, act, then re-observe to verify.
This is a general capability-routing rule, not an app-specific workflow.

End with exactly one of these prefixes:
VERIFIED OUTCOME: only when direct evidence confirms the requested condition.
UNVERIFIED: when evidence is missing, the goal is blocked, or an attempt failed.

Goal: ${goal}`,
        }],
      });
      turnId = turn.turn.id;
      const completion = await turnDone;
      const status = completion.turn?.status;
      const verified =
        status === "completed" &&
        finalText.trimStart().startsWith("VERIFIED OUTCOME:");
      const result = {
        summary: finalText.trim() || `Codex turn ended with status ${status ?? "unknown"}.`,
        verified,
        usage: latestUsage,
        accountUsage: latestAccountUsage,
      };
      diagnosticLog("codex.task", "execution.completed", {
        status,
        verified,
        failedTool,
        summary: result.summary,
      });
      if (!verified) this.computerUseHealth.observeFailure(result.summary);
      return result;
    } catch (error) {
      this.computerUseHealth.observeFailure(
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    } finally {
      signal.removeEventListener("abort", revokeAuthority);
      if (authorityRevoked) terminate("executor cleanup after revocation", true);
      else await shutdownGracefully();
      this.child = null;
    }
  }
}

/**
 * A separate, read-only Codex turn used exclusively by Restart Recovery. It
 * refuses every request that could operate a Mac, service, or file, and only
 * returns whether the saved Task scope still matches what it can observe.
 */
export class CodexRecoveryObserver implements RecoveryObserver {
  async observe(task: TaskSnapshot): Promise<{ scopeStillMatches: boolean; detail?: string }> {
    const codex = process.env.CODEX_CLI_PATH || "/Applications/ChatGPT.app/Contents/Resources/codex";
    diagnosticLog("codex.recovery", "observation.requested", {
      taskId: task.id,
      status: task.status,
      goal: textMeta(task.goal),
      binaryExists: existsSync(codex),
    });
    if (!existsSync(codex)) return { scopeStillMatches: false, detail: "Codex is unavailable to re-observe the current state." };

    const child = spawn(codex, ["app-server", "--listen", "stdio://"], {
      cwd: process.cwd(), env: { ...process.env }, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    let nextId = 1;
    let buffer = "";
    let finalText = "";
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    let resolveTurn: ((value: any) => void) | undefined;
    const turnDone = new Promise<any>((resolve) => { resolveTurn = resolve; });
    const send = (message: JsonRpcMessage) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const request = (method: string, params: Record<string, unknown> = {}) => {
      const id = nextId++;
      send({ id, method, params });
      return new Promise<any>((resolve, reject) => pending.set(id, { resolve, reject }));
    };
    const denyAction = (message: JsonRpcMessage) => {
      // Recovery may observe only through the app-server's read-only sandbox.
      // It must never inherit the original Task's authority or approval.
      send({ id: message.id, result: { decision: "decline" } });
    };
    const handle = (message: JsonRpcMessage) => {
      if (message.id != null && message.method) { denyAction(message); return; }
      if (message.id != null) {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message ?? "Codex recovery request failed"));
        else waiter.resolve(message.result);
        return;
      }
      const params = message.params ?? {};
      if (message.method === "item/agentMessage/delta") finalText += String(params.delta ?? "");
      else if (message.method === "item/completed" && params.item?.type === "agentMessage" && params.item.text) finalText = params.item.text;
      else if (message.method === "turn/completed") resolveTurn?.(params);
    };
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try { handle(JSON.parse(line) as JsonRpcMessage); } catch { /* JSONL only */ }
      }
    });
    const stop = () => { try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill(); } };

    try {
      await request("initialize", { clientInfo: { name: "bmo-companion", title: "BMO Companion", version: "0.1.0" } });
      send({ method: "initialized" });
      const thread = await request("thread/start", {
        cwd: process.cwd(), ephemeral: true, sandbox: "read-only", approvalsReviewer: "user",
      });
      await request("turn/start", {
        threadId: thread.thread.id,
        input: [{ type: "text", text: `You are a read-only Restart Recovery observer for BMO. Do not perform, request, suggest, or approve any action. Do not modify files, applications, browser state, services, or accounts. Inspect only state available without an approval. Compare it to this saved Task scope:\n\nGoal: ${task.goal}\nLast known status: ${task.status}\nLast recorded progress: ${task.progress.at(-1) ?? "none"}\n\nReturn exactly one line: STATE MATCHES: <brief observation> if the current observable state still safely matches the scope, otherwise STATE CHANGED: <brief reason>. If you cannot directly observe enough state, return STATE CHANGED.` }],
      });
      await turnDone;
      const detail = finalText.trim() || "Recovery observation returned no usable state.";
      const result = { scopeStillMatches: detail.startsWith("STATE MATCHES:"), detail };
      diagnosticLog("codex.recovery", "observation.completed", result);
      return result;
    } catch (error) {
      const result = { scopeStillMatches: false, detail: error instanceof Error ? error.message : "Recovery observation failed." };
      diagnosticLog("codex.recovery", "observation.failed", result);
      return result;
    } finally {
      stop();
    }
  }
}
