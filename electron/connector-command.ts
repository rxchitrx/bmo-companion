import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter } from "node:path";
import type {
  ConnectorCommandResult,
  ConnectorCommandRunner,
} from "./connector-types.js";
import { diagnosticLog } from "./diagnostics.js";

const MAX_OUTPUT = 2 * 1024 * 1024;

function commandPath(binary: string) {
  if (binary.includes("/")) return binary;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = `${directory}/${binary}`;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue looking.
    }
  }
  return null;
}

export class SpawnConnectorCommandRunner implements ConnectorCommandRunner {
  exists(binary: string) {
    return commandPath(binary) != null;
  }

  async run(
    binary: string,
    args: string[],
    options: {
      signal?: AbortSignal;
      stdin?: string;
      timeoutMs?: number;
      env?: NodeJS.ProcessEnv;
    } = {},
  ): Promise<ConnectorCommandResult> {
    const resolved = commandPath(binary);
    if (!resolved) throw new Error(`${binary} is not installed.`);
    if (options.signal?.aborted) throw new Error("Connector action was cancelled.");
    diagnosticLog("connectors.command", "spawn", {
      binary,
      argumentCount: args.length,
      // Argument values can contain mail, notes, filenames, and other personal data.
      argumentNames: args.filter((value) => value.startsWith("-")).slice(0, 20),
    });

    return new Promise((resolve, reject) => {
      const child = spawn(resolved, args, {
        env: options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let forceKillTimer: NodeJS.Timeout | null = null;
      const finish = (
        error?: Error,
        result?: ConnectorCommandResult,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(result!);
      };
      const terminate = (error: Error) => {
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
        }, 2_000);
        forceKillTimer.unref();
        finish(error);
      };
      const abort = () => terminate(new Error("Connector action was cancelled."));
      options.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        terminate(new Error(`${binary} timed out after ${options.timeoutMs ?? 30_000} ms.`));
      }, options.timeoutMs ?? 30_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = (stdout + chunk).slice(-MAX_OUTPUT);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-MAX_OUTPUT);
      });
      child.once("error", (error) => finish(error));
      child.once("exit", (code) => {
        if (forceKillTimer) clearTimeout(forceKillTimer);
        const exitCode = code ?? 1;
        if (exitCode !== 0) {
          const message = stderr.trim() || stdout.trim() || `${binary} exited with ${exitCode}.`;
          finish(new Error(message.slice(0, 4_000)));
          return;
        }
        finish(undefined, { stdout, stderr, exitCode });
      });
      if (options.stdin != null) child.stdin.end(options.stdin);
      else child.stdin.end();
    });
  }
}
