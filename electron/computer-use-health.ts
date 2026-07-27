import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { diagnosticLog } from "./diagnostics.js";

const execFileAsync = promisify(execFile);
const SERVICE_MARKER =
  "/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService";
const UNHEALTHY_PATTERN =
  /computer use session was stopped|readline was closed|timed out waiting for tools\/call/i;

export interface ComputerUseProcessController {
  listExactHelpers(): Promise<number[]>;
  terminate(pid: number): void;
  isRunning(pid: number): Promise<boolean>;
}

class MacComputerUseProcessController implements ComputerUseProcessController {
  async listExactHelpers(): Promise<number[]> {
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
      if ((error as { code?: number }).code !== 1) throw error;
    }

    const exact: number[] = [];
    for (const pid of candidates) {
      try {
        const { stdout } = await execFileAsync("/bin/ps", [
          "-p",
          String(pid),
          "-o",
          "command=",
        ]);
        if (stdout.includes(SERVICE_MARKER)) exact.push(pid);
      } catch {
        // It exited between pgrep and ps.
      }
    }
    return exact;
  }

  terminate(pid: number) {
    process.kill(pid, "SIGTERM");
  }

  async isRunning(pid: number): Promise<boolean> {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

export interface ComputerUseTaskLease {
  baselineHelperPids: number[];
  startedAt: number;
}

export class ComputerUseHealth {
  private unhealthyReason: string | null = null;

  constructor(
    private readonly processes: ComputerUseProcessController =
      new MacComputerUseProcessController(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  observeFailure(message: string | undefined) {
    if (!this.isSessionFailure(message)) return;
    this.unhealthyReason = message!;
    diagnosticLog("computer-use.health", "marked_unhealthy", {
      reason: message,
    });
  }

  isSessionFailure(message: string | undefined) {
    return !!message && UNHEALTHY_PATTERN.test(message);
  }

  async beginTask(
    kind: "general" | "coding" | "computer" | "browser" | undefined,
  ): Promise<ComputerUseTaskLease | undefined> {
    if (!["computer", "browser"].includes(kind ?? "")) return undefined;
    const baselineHelperPids = await this.processes.listExactHelpers();
    const lease = { baselineHelperPids, startedAt: this.now() };
    diagnosticLog("computer-use.health", "task_lease.started", {
      baselineHelperCount: baselineHelperPids.length,
    });
    return lease;
  }

  async prepare(
    kind: "general" | "coding" | "computer" | "browser" | undefined,
    progress: (message: string) => void,
  ) {
    if (!this.unhealthyReason || !["computer", "browser"].includes(kind ?? "")) {
      return;
    }
    progress("Starting a fresh owned Computer Use session after the previous session stopped.");
    diagnosticLog("computer-use.health", "fresh_session_required", {
      reason: this.unhealthyReason,
    });
    this.unhealthyReason = null;
  }

  /**
   * Stops only a helper that appeared after this Task began. A pre-existing
   * helper can belong to Codex or another application and is never terminated.
   */
  async quarantineOwnedSession(
    lease: ComputerUseTaskLease | undefined,
    reason: string,
    progress: (message: string) => void,
  ): Promise<{ stoppedPids: number[]; skippedSharedPids: number[] }> {
    this.unhealthyReason = reason;
    diagnosticLog("computer-use.health", "marked_unhealthy", { reason });
    if (!lease) return { stoppedPids: [], skippedSharedPids: [] };

    progress("Computer Use lost its session. Stopping its owned helper before reconciliation.");
    const current = await this.processes.listExactHelpers();
    const baseline = new Set(lease.baselineHelperPids);
    const owned = current.filter((pid) => !baseline.has(pid));
    const skippedSharedPids = current.filter((pid) => baseline.has(pid));
    const stoppedPids: number[] = [];

    for (const pid of owned) {
      try {
        this.processes.terminate(pid);
        stoppedPids.push(pid);
      } catch {
        // It may already have exited.
      }
    }

    const deadline = this.now() + 2_000;
    while (
      stoppedPids.length &&
      this.now() < deadline &&
      (await Promise.all(stoppedPids.map((pid) => this.processes.isRunning(pid))))
        .some(Boolean)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    diagnosticLog("computer-use.health", "owned_session.quarantined", {
      stoppedCount: stoppedPids.length,
      skippedSharedCount: skippedSharedPids.length,
      elapsedMs: this.now() - lease.startedAt,
    });
    return { stoppedPids, skippedSharedPids };
  }
}
