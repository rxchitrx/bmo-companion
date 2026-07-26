#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const codexBinary =
  process.env.CODEX_CLI_PATH ||
  "/Applications/ChatGPT.app/Contents/Resources/codex";

const userGoal = process.argv.slice(2).join(" ").trim();

if (!userGoal) {
  console.error(
    'Usage: node run-agent-app-server.mjs "your natural-language command"',
  );
  process.exit(1);
}

if (!existsSync(codexBinary)) {
  console.error(`Codex executable was not found at ${codexBinary}`);
  process.exit(1);
}

const terminal = createInterface({
  input: process.stdin,
  output: process.stdout,
});

const server = spawn(codexBinary, ["app-server", "--listen", "stdio://"], {
  cwd: process.cwd(),
  env: { ...process.env },
  detached: true,
  stdio: ["pipe", "pipe", "pipe"],
});

server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => {
  for (const line of chunk.split("\n")) {
    if (line.trim() && !line.includes(" WARN ")) {
      console.error(`[app-server] ${line}`);
    }
  }
});

let nextId = 1;
let outputBuffer = "";
let finalMessage = "";
let activeTurnDone;
let resolveActiveTurn;
const pending = new Map();
let taskAuthorizationGranted = false;

function send(message) {
  server.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params = {}) {
  const id = nextId++;
  send({ id, method, params });

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

async function askChoice(question, choices) {
  while (true) {
    const answer = (await terminal.question(`${question} `)).trim().toLowerCase();
    const match = choices.find(
      (choice) =>
        answer === choice.key ||
        answer === choice.value.toLowerCase() ||
        choice.aliases?.includes(answer),
    );
    if (match) return match.value;
    console.log(`Choose: ${choices.map((choice) => choice.key).join("/")}`);
  }
}

async function promptForSchema(schema = {}) {
  const content = {};
  const properties = schema.properties || {};
  const required = new Set(schema.required || []);

  for (const [name, field] of Object.entries(properties)) {
    const label = field.title || name;
    if (field.description) console.log(`\n${field.description}`);

    if (Array.isArray(field.enum) && field.enum.length > 0) {
      console.log(
        `${label}: ${field.enum
          .map((value, index) => `[${index + 1}] ${value}`)
          .join("  ")}`,
      );
      while (true) {
        const answer = (
          await terminal.question(
            `Choose ${label}${field.default != null ? ` [${field.default}]` : ""}: `,
          )
        ).trim();
        if (!answer && field.default != null) {
          content[name] = field.default;
          break;
        }
        const index = Number(answer) - 1;
        if (Number.isInteger(index) && field.enum[index] != null) {
          content[name] = field.enum[index];
          break;
        }
        if (field.enum.includes(answer)) {
          content[name] = answer;
          break;
        }
        console.log("Enter one of the listed numbers or values.");
      }
      continue;
    }

    const type =
      typeof field.type === "string"
        ? field.type
        : Array.isArray(field.type)
          ? field.type.find((value) => value !== "null")
          : "string";

    if (type === "boolean") {
      const value = await askChoice(`${label} [y/n]:`, [
        { key: "y", value: "true", aliases: ["yes"] },
        { key: "n", value: "false", aliases: ["no"] },
      ]);
      content[name] = value === "true";
      continue;
    }

    const answer = (
      await terminal.question(
        `${label}${field.default != null ? ` [${field.default}]` : ""}: `,
      )
    ).trim();

    if (!answer && field.default != null) {
      content[name] = field.default;
    } else if (!answer && !required.has(name)) {
      continue;
    } else if (type === "number" || type === "integer") {
      content[name] = Number(answer);
    } else {
      content[name] = answer;
    }
  }

  return content;
}

function buildAutomaticFormContent(schema = {}) {
  const content = {};
  const properties = schema.properties || {};

  for (const [name, field] of Object.entries(properties)) {
    if (field.const !== undefined) {
      content[name] = field.const;
    } else if (field.default !== undefined) {
      content[name] = field.default;
    } else if (Array.isArray(field.enum) && field.enum.length > 0) {
      content[name] = field.enum[0];
    } else if (field.type === "boolean") {
      content[name] = true;
    }
  }

  return content;
}

async function handleElicitation(message) {
  const params = message.params || {};

  if (taskAuthorizationGranted && params.mode !== "url") {
    console.log("\n[Auto-approved Computer Use request for this task]");
    if (process.env.DEBUG_APPROVALS === "1") {
      console.log(JSON.stringify(params, null, 2));
    }
    const schema = params.requestedSchema || {};
    const isMcpToolApproval =
      params._meta?.codex_approval_kind === "mcp_tool_call";
    const hasFormFields =
      schema.properties && Object.keys(schema.properties).length > 0;

    // Let app-server finish registering the pending elicitation before replying.
    // Human clients naturally introduce this small delay.
    await new Promise((resolve) => setTimeout(resolve, 350));

    send({
      id: message.id,
      result: isMcpToolApproval && !hasFormFields
        ? {
            action: "accept",
            content: {},
            _meta: { persist: "session" },
          }
        : {
            action: "accept",
            content: buildAutomaticFormContent(schema),
          },
    });
    return;
  }

  console.log("\n\n── Computer Use / MCP request ──");
  console.log(`From: ${params.serverName || "unknown service"}`);
  console.log(params.message || "The service is requesting input.");

  if (params.mode === "url") {
    console.log(`Open this URL manually if you want to continue:\n${params.url}`);
    const action = await askChoice("Continue after completing it? [y/n]:", [
      { key: "y", value: "accept", aliases: ["yes", "allow"] },
      { key: "n", value: "decline", aliases: ["no", "deny"] },
    ]);
    send({
      id: message.id,
      result: { action, content: null },
    });
    return;
  }

  const action = await askChoice("Allow this request? [y/n]:", [
    { key: "y", value: "accept", aliases: ["yes", "allow"] },
    { key: "n", value: "decline", aliases: ["no", "deny"] },
  ]);

  if (action === "decline") {
    send({ id: message.id, result: { action, content: null } });
    return;
  }

  const content = await promptForSchema(params.requestedSchema || {});
  send({ id: message.id, result: { action: "accept", content } });
}

async function handleApproval(message) {
  const params = message.params || {};

  if (taskAuthorizationGranted) {
    console.log(`\n[Auto-approved ${message.method} for this task]`);
    send({
      id: message.id,
      result: { decision: "acceptForSession" },
    });
    return;
  }

  console.log(`\n\n── ${message.method} ──`);
  if (params.reason) console.log(params.reason);
  if (params.command) {
    const command = Array.isArray(params.command)
      ? params.command.join(" ")
      : params.command;
    console.log(`Command: ${command}`);
  }
  if (params.changes) console.log(JSON.stringify(params.changes, null, 2));

  const decision = await askChoice("Decision [y/s/n]:", [
    { key: "y", value: "accept", aliases: ["yes", "allow"] },
    {
      key: "s",
      value: "acceptForSession",
      aliases: ["session", "always"],
    },
    { key: "n", value: "decline", aliases: ["no", "deny"] },
  ]);

  send({ id: message.id, result: { decision } });
}

async function handlePermissions(message) {
  const params = message.params || {};

  if (taskAuthorizationGranted) {
    console.log("\n[Auto-granted requested permissions for this task]");
    send({
      id: message.id,
      result: {
        scope: "turn",
        permissions: params.permissions || {},
      },
    });
    return;
  }

  console.log("\n\n── Permission request ──");
  if (params.reason) console.log(params.reason);
  console.log(JSON.stringify(params.permissions || {}, null, 2));

  const decision = await askChoice("Grant these permissions? [y/s/n]:", [
    { key: "y", value: "turn", aliases: ["yes", "allow"] },
    { key: "s", value: "session", aliases: ["always"] },
    { key: "n", value: "deny", aliases: ["no"] },
  ]);

  send({
    id: message.id,
    result:
      decision === "deny"
        ? { permissions: {} }
        : {
            scope: decision,
            permissions: params.permissions || {},
          },
  });
}

async function handleServerRequest(message) {
  try {
    if (message.method === "mcpServer/elicitation/request") {
      await handleElicitation(message);
      return;
    }

    if (
      message.method === "item/commandExecution/requestApproval" ||
      message.method === "item/fileChange/requestApproval"
    ) {
      await handleApproval(message);
      return;
    }

    if (message.method === "item/permissions/requestApproval") {
      await handlePermissions(message);
      return;
    }

    console.log(`\nUnhandled server request: ${message.method}`);
    console.log(JSON.stringify(message.params || {}, null, 2));
    send({
      id: message.id,
      error: { code: -32601, message: "Unsupported request type" },
    });
  } catch (error) {
    send({
      id: message.id,
      error: { code: -32603, message: error.message },
    });
  }
}

function handleNotification(message) {
  const params = message.params || {};

  if (message.method === "item/agentMessage/delta") {
    process.stdout.write(params.delta || "");
    finalMessage += params.delta || "";
    return;
  }

  if (message.method === "item/started") {
    const type = params.item?.type;
    if (type && !["agentMessage", "reasoning"].includes(type)) {
      console.log(`\n[Started: ${type}]`);
    }
    return;
  }

  if (message.method === "item/completed") {
    const item = params.item || {};
    if (item.type === "agentMessage" && item.text) {
      finalMessage = item.text;
    } else if (item.type && item.status === "failed") {
      console.log(`\n[Failed: ${item.type}]`);
      if (item.error) {
        console.log(
          typeof item.error === "string"
            ? item.error
            : JSON.stringify(item.error, null, 2),
        );
      }
    }
    return;
  }

  if (message.method === "error") {
    console.error(`\nCodex error: ${params.message || JSON.stringify(params)}`);
    return;
  }

  if (message.method === "turn/completed") {
    resolveActiveTurn?.(params);
  }
}

function handleMessage(message) {
  if (message.id != null && message.method) {
    void handleServerRequest(message);
    return;
  }

  if (message.id != null) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(
        new Error(`${message.error.code ?? "error"}: ${message.error.message}`),
      );
    } else {
      waiter.resolve(message.result);
    }
    return;
  }

  if (message.method) handleNotification(message);
}

server.stdout.setEncoding("utf8");
server.stdout.on("data", (chunk) => {
  outputBuffer += chunk;
  while (true) {
    const newline = outputBuffer.indexOf("\n");
    if (newline < 0) break;
    const line = outputBuffer.slice(0, newline).trim();
    outputBuffer = outputBuffer.slice(newline + 1);
    if (!line) continue;
    try {
      handleMessage(JSON.parse(line));
    } catch {
      console.error(`[Unparsed app-server output] ${line}`);
    }
  }
});

server.once("exit", (code) => {
  for (const waiter of pending.values()) {
    waiter.reject(new Error(`app-server exited with code ${code}`));
  }
  pending.clear();
  resolveActiveTurn?.({
    turn: { status: "failed", error: `app-server exited with code ${code}` },
  });
});

const workerInstructions = `
You are the execution worker for a personal voice-controlled Mac assistant.
Complete the user's goal using the most appropriate available Codex tools.
For visible macOS application work, use the installed Computer Use capability.
For browser work, use the installed Browser capability when available.

Work from the goal rather than a predetermined sequence. Inspect the current
state before acting, recover from dialogs or unexpected UI, re-inspect after
meaningful actions, and verify the final result. Respect all approval and
confirmation requirements. Do not save, send, publish, purchase, delete, or
change credentials unless the user's goal explicitly authorizes that exact
action.

User goal:
${userGoal}
`.trim();

try {
  console.log("Starting approval-capable Codex app-server client...");
  console.log(`Goal: ${userGoal}\n`);

  const initialAuthorization = await askChoice(
    "Allow Codex to control your computer for this task only? [y/n]:",
    [
      { key: "y", value: "allow", aliases: ["yes"] },
      { key: "n", value: "deny", aliases: ["no"] },
    ],
  );
  if (initialAuthorization === "deny") {
    console.log("Task cancelled.");
    process.exit(0);
  }
  taskAuthorizationGranted = true;
  console.log(
    "Approved for this task. Follow-up Computer Use requests will be accepted automatically.\n",
  );

  await request("initialize", {
    clientInfo: {
      name: "personal-agent-terminal-client",
      title: "Personal Agent Approval Demo",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
      mcpServerOpenaiFormElicitation: true,
    },
  });
  send({ method: "initialized" });

  const threadResult = await request("thread/start", {
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
    approvalsReviewer:
      process.env.CODEX_AUTO_REVIEW === "1" ? "auto_review" : "user",
    sandbox: "workspace-write",
  });

  const threadId = threadResult.thread.id;
  activeTurnDone = new Promise((resolve) => {
    resolveActiveTurn = resolve;
  });

  await request("turn/start", {
    threadId,
    input: [{ type: "text", text: workerInstructions }],
  });

  const completion = await activeTurnDone;
  const status = completion.turn?.status || "unknown";

  console.log(`\n\nTurn finished: ${status}`);
  if (finalMessage.trim()) {
    console.log(`Result: ${finalMessage.trim()}`);
  }
} catch (error) {
  console.error(`\nClient failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  terminal.close();
  server.stdin.end();
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill();
  }
}
