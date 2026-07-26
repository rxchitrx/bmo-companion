#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const codexBinary =
  process.env.CODEX_CLI_PATH ||
  "/Applications/ChatGPT.app/Contents/Resources/codex";

const timeoutMs = Number(process.env.REALTIME_TEST_TIMEOUT_MS || 45_000);
const testPrompt =
  process.argv.slice(2).join(" ").trim() ||
  "Reply with exactly: Codex realtime is working.";

if (!existsSync(codexBinary)) {
  console.error(`Codex executable not found: ${codexBinary}`);
  process.exit(1);
}

const server = spawn(
  codexBinary,
  [
    "--enable",
    "realtime_conversation",
    "app-server",
    "--listen",
    "stdio://",
  ],
  {
  cwd: process.cwd(),
  env: { ...process.env },
  detached: true,
  stdio: ["pipe", "pipe", "pipe"],
  },
);

server.stdout.setEncoding("utf8");
server.stderr.setEncoding("utf8");

let nextId = 1;
let stdoutBuffer = "";
let stderrText = "";
let startedNotification = null;
let assistantTranscript = "";
let realtimeError = null;
let realtimeClosed = null;
const pending = new Map();
const notifications = [];
const waiters = new Set();

function send(message) {
  server.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params = {}) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => {
    pending.set(id, { method, resolve, reject });
  });
}

function notifyWaiters(message) {
  for (const waiter of [...waiters]) {
    if (!waiter.predicate(message)) continue;
    waiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }
}

function waitForNotification(predicate, label, ms = timeoutMs) {
  const existing = notifications.find(predicate);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve,
      timer: setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`Timed out waiting for ${label} after ${ms} ms`));
      }, ms),
    };
    waiters.add(waiter);
  });
}

function handleNotification(message) {
  notifications.push(message);
  const params = message.params || {};

  if (message.method === "thread/realtime/started") {
    startedNotification = params;
    console.log(
      `Realtime started: version=${params.version}, session=${params.realtimeSessionId || "not exposed"}`,
    );
  } else if (message.method === "thread/realtime/transcript/delta") {
    if (params.role === "assistant") {
      assistantTranscript += params.delta || "";
      process.stdout.write(params.delta || "");
    }
  } else if (message.method === "thread/realtime/transcript/done") {
    if (params.role === "assistant") {
      assistantTranscript = params.text || assistantTranscript;
      console.log();
    }
  } else if (message.method === "thread/realtime/error") {
    realtimeError = params;
    console.error(`Realtime error: ${params.message || JSON.stringify(params)}`);
  } else if (message.method === "thread/realtime/closed") {
    realtimeClosed = params;
    console.log(`Realtime closed: ${params.reason || "no reason supplied"}`);
  } else if (message.method === "error") {
    console.error(`App-server error: ${params.message || JSON.stringify(params)}`);
  }

  notifyWaiters(message);
}

function handleMessage(message) {
  if (message.id != null && message.method) {
    console.error(`Unexpected server request during diagnostic: ${message.method}`);
    send({
      id: message.id,
      error: { code: -32601, message: "Diagnostic client cannot answer this request" },
    });
    return;
  }

  if (message.id != null) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(
        new Error(
          `${waiter.method}: ${message.error.code ?? "error"}: ${message.error.message}`,
        ),
      );
    } else {
      waiter.resolve(message.result);
    }
    return;
  }

  if (message.method) handleNotification(message);
}

server.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  while (true) {
    const newline = stdoutBuffer.indexOf("\n");
    if (newline < 0) break;
    const line = stdoutBuffer.slice(0, newline).trim();
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) continue;
    try {
      handleMessage(JSON.parse(line));
    } catch {
      console.error(`[unparsed app-server output] ${line}`);
    }
  }
});

server.stderr.on("data", (chunk) => {
  stderrText += chunk;
  if (process.env.DEBUG_REALTIME === "1") process.stderr.write(chunk);
});

server.once("exit", (code, signal) => {
  const error = new Error(
    `Codex app-server exited unexpectedly: code=${code}, signal=${signal}`,
  );
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve({
      method: "process/exited",
      params: { code, signal },
    });
  }
  waiters.clear();
});

async function cleanup(threadId) {
  if (threadId && startedNotification && !realtimeClosed) {
    try {
      await Promise.race([
        request("thread/realtime/stop", { threadId }),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    } catch {
      // The process-group cleanup below is the final cleanup path.
    }
  }

  server.stdin.end();
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
}

let threadId = null;

try {
  console.log(`Codex binary: ${codexBinary}`);
  console.log("Initializing experimental app-server protocol...");

  await request("initialize", {
    clientInfo: {
      name: "personal-agent-realtime-diagnostic",
      title: "Personal Agent Realtime Diagnostic",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  });
  send({ method: "initialized" });

  const account = await request("account/read", { refreshToken: false });
  console.log(
    `Authentication: ${account?.account?.type || account?.authMode || "authenticated account detected"}`,
  );

  const threadResult = await request("thread/start", {
    cwd: process.cwd(),
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  threadId = threadResult.thread.id;
  console.log(`Thread created: ${threadId}`);

  console.log("Starting thread/realtime/start with text output...");
  await request("thread/realtime/start", {
    threadId,
    outputModality: "text",
    version: "v2",
    includeStartupContext: false,
    prompt:
      "You are a realtime diagnostic assistant. Answer briefly and follow the user's exact response-format request.",
    transport: { type: "websocket" },
  });

  await waitForNotification(
    (message) =>
      message.method === "thread/realtime/started" ||
      message.method === "thread/realtime/error" ||
      message.method === "thread/realtime/closed",
    "realtime startup",
  );

  if (realtimeError) {
    throw new Error(realtimeError.message || JSON.stringify(realtimeError));
  }
  if (!startedNotification) {
    throw new Error(
      `Realtime did not start${realtimeClosed?.reason ? `: ${realtimeClosed.reason}` : ""}`,
    );
  }

  console.log(`Sending test text: ${testPrompt}`);
  await request("thread/realtime/appendText", {
    threadId,
    role: "user",
    text: testPrompt,
  });

  const outcome = await waitForNotification(
    (message) =>
      (message.method === "thread/realtime/transcript/done" &&
        message.params?.role === "assistant") ||
      message.method === "thread/realtime/error" ||
      message.method === "thread/realtime/closed",
    "assistant realtime response",
  );

  if (realtimeError) {
    throw new Error(realtimeError.message || JSON.stringify(realtimeError));
  }
  if (outcome.method !== "thread/realtime/transcript/done") {
    throw new Error(
      `Realtime closed before an assistant response: ${
        realtimeClosed?.reason || JSON.stringify(outcome.params || {})
      }`,
    );
  }

  console.log("\nRESULT: PASS");
  console.log(`Assistant transcript: ${assistantTranscript.trim()}`);
  console.log(
    "The ChatGPT-authenticated Codex app-server accepted and completed a realtime session.",
  );
} catch (error) {
  console.error("\nRESULT: FAIL");
  console.error(error.message);
  if (stderrText.trim()) {
    const relevant = stderrText
      .split("\n")
      .filter(
        (line) =>
          /realtime|bidi|auth|entitle|subscription|forbidden|unauthorized|error/i.test(
            line,
          ),
      )
      .slice(-30);
    if (relevant.length) {
      console.error("\nRelevant app-server diagnostics:");
      console.error(relevant.join("\n"));
    }
  }
  process.exitCode = 1;
} finally {
  await cleanup(threadId);
}
