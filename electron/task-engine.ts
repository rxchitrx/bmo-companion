import { CodexRecoveryObserver, CodexTaskExecutor } from "./codex-adapter.js";
import { PiCodingTaskExecutor } from "./pi-coding-adapter.js";
import type { ComputerUseHealth } from "./computer-use-health.js";
import type { CompanionEngine } from "./companion-engine.js";
import type { RecoveryObserver, TaskExecutor } from "./task-runtime.js";

/** BMO owns the task boundary and selects a transport for each scoped Task. */
export function createBmoTaskEngine(
  computerUseHealth: ComputerUseHealth,
  codeWorkspacesDirectory: string,
  options: {
    codingProvider?: "pi" | "codex";
    codexExecutor?: TaskExecutor;
    piExecutor?: TaskExecutor;
    codexRecovery?: RecoveryObserver;
  } = {},
): Pick<CompanionEngine, "taskExecutor" | "recoveryObserver"> {
  const codex = options.codexExecutor ?? new CodexTaskExecutor(computerUseHealth, codeWorkspacesDirectory);
  const pi = options.piExecutor ?? new PiCodingTaskExecutor(codeWorkspacesDirectory);
  const codexRecovery = options.codexRecovery ?? new CodexRecoveryObserver();
  const codingProvider = options.codingProvider ?? "pi";
  const taskExecutor: TaskExecutor = {
    execute(goal, signal, progress, usage, accountUsage, execution) {
      return execution?.kind === "coding" && codingProvider === "pi"
        ? pi.execute(goal, signal, progress, usage, accountUsage, execution)
        : codex.execute(goal, signal, progress, usage, accountUsage, execution);
    },
  };
  const recoveryObserver: RecoveryObserver = {
    observe(task) {
      if (task.kind === "coding" && codingProvider === "pi") {
        return Promise.resolve({
          scopeStillMatches: false,
          detail: "The interrupted Pi code worktree requires owner review. BMO will not replay its edits automatically.",
        });
      }
      return codexRecovery.observe(task);
    },
    reconcile(task) {
      if (task.kind === "coding" && codingProvider === "pi") {
        return Promise.resolve({ detail: "Review the existing Pi code worktree before any retry." });
      }
      return codexRecovery.reconcile?.(task) ?? Promise.resolve({ detail: "No reconciliation observer is available." });
    },
  };
  return { taskExecutor, recoveryObserver };
}
