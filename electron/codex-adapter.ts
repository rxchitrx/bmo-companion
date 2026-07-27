import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import type { ExecutionResult, RecoveryObserver, TaskExecutor, TaskSnapshot } from "./task-runtime.js";
import { diagnosticLog, textMeta } from "./diagnostics.js";

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code?: number; message?: string };
}

export class CodexTaskExecutor implements TaskExecutor {
  private child: ChildProcessWithoutNullStreams | null = null;

  async execute(
    goal: string,
    signal: AbortSignal,
    progress: (message: string) => void,
  ): Promise<ExecutionResult> {
    const codex =
      process.env.CODEX_CLI_PATH ||
      "/Applications/ChatGPT.app/Contents/Resources/codex";
    diagnosticLog("codex.task", "execution.requested", {
      goal: textMeta(goal),
      binaryExists: existsSync(codex),
      aborted: signal.aborted,
    });
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
    const pending = new Map<number, {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
    }>();
    let resolveTurn: ((value: any) => void) | undefined;
    const turnDone = new Promise<any>((resolve) => { resolveTurn = resolve; });

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
      diagnosticLog("codex.task", "rpc.server_request", {
        id: message.id,
        method: message.method,
        paramKeys: Object.keys(params),
      });
      if (message.method === "item/permissions/requestApproval") {
        send({ id: message.id, result: { scope: "turn", permissions: params.permissions ?? {} } });
      } else if (
        message.method === "item/commandExecution/requestApproval" ||
        message.method === "item/fileChange/requestApproval"
      ) {
        send({ id: message.id, result: { decision: "accept" } });
      } else if (message.method === "mcpServer/elicitation/request") {
        if (params.mode === "url") {
          send({ id: message.id, result: { action: "decline", content: null } });
          progress("This task needs a separate sign-in or connection decision.");
          return;
        }
        const schema = params.requestedSchema as { properties?: Record<string, any> } | undefined;
        const content: Record<string, unknown> = {};
        for (const [key, field] of Object.entries(schema?.properties ?? {})) {
          if (field.const !== undefined) content[key] = field.const;
          else if (field.default !== undefined) content[key] = field.default;
          else if (Array.isArray(field.enum) && field.enum.length) content[key] = field.enum[0];
          else if (field.type === "boolean") content[key] = true;
        }
        const isToolApproval = params._meta?.codex_approval_kind === "mcp_tool_call";
        send({
          id: message.id,
          result: isToolApproval && Object.keys(content).length === 0
            ? { action: "accept", content: {}, _meta: { persist: "session" } }
            : { action: "accept", content },
        });
      } else {
        send({ id: message.id, error: { code: -32601, message: "Unsupported request" } });
      }
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
        itemType: params.item?.type,
        itemStatus: params.item?.status,
        turnStatus: params.turn?.status,
        delta: params.delta,
        message: params.message,
      });
      if (message.method === "item/agentMessage/delta") {
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
    child.once("exit", (code, processSignal) =>
      diagnosticLog("codex.task", "process.exited", { code, signal: processSignal }));

    const stop = () => {
      diagnosticLog("codex.task", "process.stop", { pid: child.pid, aborted: signal.aborted });
      try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill(); }
    };
    signal.addEventListener("abort", stop, { once: true });

    try {
      progress("Connecting to the managed Codex app-server.");
      await request("initialize", {
        clientInfo: { name: "bmo-companion", title: "BMO Companion", version: "0.1.0" },
        capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
      });
      send({ method: "initialized" });
      const thread = await request("thread/start", {
        cwd: process.cwd(),
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
      });
      progress("Codex is observing the current state and choosing an approach.");
      await request("turn/start", {
        threadId: thread.thread.id,
        input: [{
          type: "text",
          text: `You are the execution worker for BMO, a personal Mac Companion.
Complete the goal using the most appropriate installed Codex capabilities.
Reason from the goal and current observed state; never use a predetermined
coordinate, shortcut, selector, or app-specific recipe. Recover from unexpected
state and re-observe after meaningful actions. Do not permanently delete
anything. Verify the requested real-world outcome before claiming completion.

End with exactly one of these prefixes:
VERIFIED OUTCOME: only when direct evidence confirms the requested condition.
UNVERIFIED: when evidence is missing, the goal is blocked, or an attempt failed.

Goal: ${goal}`,
        }],
      });
      const completion = await turnDone;
      const status = completion.turn?.status;
      const verified =
        status === "completed" &&
        !failedTool &&
        finalText.trimStart().startsWith("VERIFIED OUTCOME:");
      const result = {
        summary: finalText.trim() || `Codex turn ended with status ${status ?? "unknown"}.`,
        verified,
      };
      diagnosticLog("codex.task", "execution.completed", {
        status,
        verified,
        failedTool,
        summary: result.summary,
      });
      return result;
    } finally {
      signal.removeEventListener("abort", stop);
      stop();
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
