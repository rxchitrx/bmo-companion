import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { diagnosticLog } from "./diagnostics.js";

const execFileAsync = promisify(execFile);
const SERVICE_MARKER =
  "/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService";
const UNHEALTHY_PATTERN =
  /computer use session was stopped|readline was closed|timed out waiting for tools\/call/i;

export class ComputerUseHealth {
  private unhealthyReason: string | null = null;

  observeFailure(message: string | undefined) {
    if (!message || !UNHEALTHY_PATTERN.test(message)) return;
    this.unhealthyReason = message;
    diagnosticLog("computer-use.health", "marked_unhealthy", {
      reason: message,
    });
  }

  isSessionFailure(message: string | undefined) {
    return !!message && UNHEALTHY_PATTERN.test(message);
  }

  async prepare(
    kind: "general" | "coding" | "computer" | "browser" | undefined,
    progress: (message: string) => void,
  ) {
    if (!this.unhealthyReason || !["computer", "browser"].includes(kind ?? "")) {
      return;
    }
    progress("Recovering the Computer Use helper after its previous session stopped.");
    const priorReason = this.unhealthyReason;
    this.unhealthyReason = null;
    let candidates: number[] = [];
    try {
      const { stdout } = await execFileAsync("/usr/bin/pgrep", [
        "-f",
        SERVICE_MARKER,
      ]);
      candidates = stdout
        .split(/\s+/)
        .map(Number)
        .filter((pid) => Number.isSafeInteger(pid) && pid > 1);
    } catch (error) {
      if ((error as { code?: number }).code !== 1) {
        this.unhealthyReason = priorReason;
        throw error;
      }
    }

    const stopped: number[] = [];
    for (const pid of candidates) {
      try {
        const { stdout } = await execFileAsync("/bin/ps", [
          "-p",
          String(pid),
          "-o",
          "command=",
        ]);
        if (!stdout.includes(SERVICE_MARKER)) continue;
        process.kill(pid, "SIGTERM");
        stopped.push(pid);
      } catch {
        // The exact helper may already have exited; the next MCP client relaunches it.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    diagnosticLog("computer-use.health", "helper_recovered", {
      stoppedCount: stopped.length,
    });
  }
}
