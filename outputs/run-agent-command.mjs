#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const codexBinary =
  process.env.CODEX_CLI_PATH ||
  "/Applications/ChatGPT.app/Contents/Resources/codex";

const command = process.argv.slice(2).join(" ").trim();

if (!command) {
  console.error('Usage: node run-agent-command.mjs "your natural-language command"');
  process.exit(1);
}

if (!existsSync(codexBinary)) {
  console.error(`Codex executable was not found at ${codexBinary}`);
  process.exit(1);
}

const workerPrompt = `
You are the execution worker for a personal voice-controlled Mac assistant.

Complete the user's goal using the most appropriate available Codex tools.
For visible macOS application work, use the installed Computer Use capability.
For browser work, use the installed Browser capability when available.

Operate from the goal, not a predetermined sequence:
- Inspect the current state before acting.
- Decide the next action from fresh evidence.
- If the expected UI is missing, blocked by a dialog, or in the wrong state,
  diagnose it and recover.
- After every meaningful action, inspect the state again before continuing.
- Never reuse stale accessibility element indexes.
- Verify the final result visibly.
- Respect all confirmation requirements exposed by the tools.
- Do not save, send, publish, purchase, delete, or change credentials unless the
  user's goal explicitly authorizes that exact action.
- Give a concise final report of what actually happened.

User goal:
${command}
`.trim();

console.log("Starting a fresh goal-driven Codex worker...");
console.log(`Goal: ${command}`);
console.log("");

const child = spawn(
  codexBinary,
  [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "--cd",
    process.cwd(),
    workerPrompt,
  ],
  {
    env: { ...process.env },
    stdio: ["ignore", "inherit", "inherit"],
  },
);

child.once("error", (error) => {
  console.error(`Unable to start Codex: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Codex stopped after receiving ${signal}.`);
    process.exitCode = 1;
    return;
  }

  process.exitCode = code ?? 1;
});
