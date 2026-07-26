#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEMO_TEXT =
  "Hello from your custom agent.\n\n" +
  "This sentence was typed through Codex Computer Use without opening the Codex interface.";

const pause = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

function findComputerUsePlugin(codexHome) {
  const base = join(
    codexHome,
    "plugins",
    "cache",
    "openai-bundled",
    "computer-use",
  );

  if (!existsSync(base)) {
    throw new Error(
      "The Codex Computer Use plugin is not installed. Open Codex and enable Computer Use first.",
    );
  }

  const versions = readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

  if (versions.length === 0) {
    throw new Error("No installed Computer Use plugin version was found.");
  }

  return join(base, versions[0]);
}

class McpClient {
  constructor(command, args, options) {
    this.child = spawn(command, args, {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.stderrBuffer = "";

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderrBuffer += chunk;
    });

    this.child.once("exit", (code) => {
      const error = new Error(
        `Computer Use service exited unexpectedly with code ${code}.`,
      );
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    });
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;

    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) break;

      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }

      if (message.id == null) continue;
      const waiter = this.pending.get(message.id);
      if (!waiter) continue;
      this.pending.delete(message.id);

      if (message.error) {
        waiter.reject(
          new Error(`${message.error.code}: ${message.error.message}`),
        );
      } else {
        waiter.resolve(message.result);
      }
    }
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = 20_000) {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: {
        name: "personal-computer-use-visible-demo",
        version: "0.1.0",
      },
    });

    this.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });

    return result;
  }

  async callTool(name, args = {}) {
    const result = await this.request(
      "tools/call",
      { name, arguments: args },
      30_000,
    );

    if (result.isError) {
      const message = (result.content || [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      throw new Error(message || `${name} failed.`);
    }

    return result;
  }

  close() {
    this.child.stdin.end();
    this.child.kill();
  }
}

const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const pluginDirectory = findComputerUsePlugin(codexHome);
const launcher = join(
  pluginDirectory,
  "bin",
  "computer-use-client-launcher",
);

if (!existsSync(launcher)) {
  throw new Error(`Computer Use launcher is missing: ${launcher}`);
}

const client = new McpClient(launcher, ["mcp"], {
  cwd: pluginDirectory,
  env: { ...process.env, CODEX_HOME: codexHome },
});

try {
  console.log("1/6  Connecting to Codex Computer Use...");
  const server = await client.initialize();
  console.log(`     Connected to ${server.serverInfo?.name || "Computer Use"}.`);

  console.log("2/6  Opening TextEdit on screen...");
  await run("/usr/bin/open", ["-a", "TextEdit"]);
  await pause(1_500);

  console.log("3/6  Reading TextEdit through Computer Use...");
  await client.callTool("get_app_state", { app: "TextEdit" });
  await pause(1_000);

  console.log("4/6  Dismissing TextEdit's file chooser...");
  await client.callTool("press_key", {
    app: "TextEdit",
    key: "Escape",
  });
  await pause(1_000);

  console.log("     Creating a new document...");
  await client.callTool("press_key", {
    app: "TextEdit",
    key: "super+n",
  });
  await pause(1_000);
  await client.callTool("get_app_state", { app: "TextEdit" });

  console.log("5/6  Typing visibly through Computer Use...");
  await client.callTool("type_text", {
    app: "TextEdit",
    text: DEMO_TEXT,
  });
  await pause(1_000);

  console.log("6/6  Verifying the visible result...");
  await client.callTool("get_app_state", { app: "TextEdit" });

  console.log("");
  console.log("Success. The document is intentionally left open and unsaved.");
  console.log("Close it yourself when you are finished inspecting the demo.");
} catch (error) {
  console.error("");
  console.error(`Demo failed: ${error.message}`);
  if (client.stderrBuffer.trim()) {
    console.error(client.stderrBuffer.trim());
  }
  process.exitCode = 1;
} finally {
  client.close();
}
