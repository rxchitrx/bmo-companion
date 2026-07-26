import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import type { ExecutionResult, TaskExecutor } from "./task-runtime.js";

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
    if (!existsSync(codex)) throw new Error(`Codex executable not found: ${codex}`);

    const child = spawn(codex, ["app-server", "--listen", "stdio://"], {
      cwd: process.cwd(),
      env: { ...process.env },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
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

    const send = (message: JsonRpcMessage) =>
      child.stdin.write(`${JSON.stringify(message)}\n`);
    const request = (method: string, params: Record<string, unknown> = {}) => {
      const id = nextId++;
      send({ id, method, params });
      return new Promise<any>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    };

    const acceptServerRequest = (message: JsonRpcMessage) => {
      const params = message.params ?? {};
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
        if (message.error) waiter.reject(new Error(message.error.message ?? "Codex request failed"));
        else waiter.resolve(message.result);
        return;
      }
      const params = message.params ?? {};
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
        try { handle(JSON.parse(line) as JsonRpcMessage); } catch { /* app-server is JSONL */ }
      }
    });

    const stop = () => {
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
      return {
        summary: finalText.trim() || `Codex turn ended with status ${status ?? "unknown"}.`,
        verified,
      };
    } finally {
      signal.removeEventListener("abort", stop);
      stop();
      this.child = null;
    }
  }
}
