#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const pluginBase = join(codexHome, "plugins", "cache", "openai-bundled", "computer-use");

function latestPluginDirectory() {
  if (!existsSync(pluginBase)) {
    throw new Error(`Computer Use plugin was not found under ${pluginBase}`);
  }

  const versions = readdirSync(pluginBase, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

  if (versions.length === 0) {
    throw new Error("No installed Computer Use plugin version was found.");
  }

  return join(pluginBase, versions[0]);
}

const pluginDirectory = latestPluginDirectory();
const launcher = join(pluginDirectory, "bin", "computer-use-client-launcher");

if (!existsSync(launcher)) {
  throw new Error(`Computer Use launcher was not found at ${launcher}`);
}

const child = spawn(launcher, ["mcp"], {
  cwd: pluginDirectory,
  env: { ...process.env, CODEX_HOME: codexHome },
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
let stdoutBuffer = "";
let stderrBuffer = "";
const pending = new Map();

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params = {}) {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function handleMessage(message) {
  if (message.id == null) return;

  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);

  if (message.error) {
    waiter.reject(new Error(`${message.error.code}: ${message.error.message}`));
  } else {
    waiter.resolve(message.result);
  }
}

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
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
      // Ignore non-protocol diagnostic output on stdout.
    }
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderrBuffer += chunk;
});

const timeout = setTimeout(() => {
  child.kill();
  console.error("Timed out waiting for the Computer Use MCP service.");
  if (stderrBuffer.trim()) console.error(stderrBuffer.trim());
  process.exitCode = 1;
}, 15_000);

try {
  const initialized = await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: {
      name: "personal-computer-use-probe",
      version: "0.1.0",
    },
  });

  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const listed = await request("tools/list");

  const tools = (listed.tools || []).map((tool) => ({
    name: tool.name,
    description: tool.description,
  }));

  let readOnlyCheck;
  if (process.argv.includes("--list-apps")) {
    const result = await request("tools/call", {
      name: "list_apps",
      arguments: {},
    });
    const textCharacters = (result.content || [])
      .filter((block) => block.type === "text")
      .reduce((total, block) => total + block.text.length, 0);

    readOnlyCheck = {
      tool: "list_apps",
      succeeded: result.isError !== true,
      returnedContentBlocks: (result.content || []).length,
      responseCharacters: textCharacters,
    };
  }

  console.log(
    JSON.stringify(
      {
        connected: true,
        server: initialized.serverInfo,
        protocolVersion: initialized.protocolVersion,
        tools,
        ...(readOnlyCheck ? { readOnlyCheck } : {}),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(`Computer Use MCP probe failed: ${error.message}`);
  if (stderrBuffer.trim()) console.error(stderrBuffer.trim());
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  child.stdin.end();
  child.kill();
}
