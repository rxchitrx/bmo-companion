import {
  allowTaskAuthority,
  createTaskAuthorityScope,
} from "../electron/permission-lifecycle.js";
import { createSafeLiveCanaryAdapter } from "./live-adapter";
import {
  createLocalSafeCanaryRuntime,
  type LocalSafeCanaryRuntimeOptions,
} from "./local-runtime";
import type { CanaryAdapter, CanaryCase } from "./types";

export interface LocalSafeCanaryHostOptions extends LocalSafeCanaryRuntimeOptions {
  now?: () => Date;
  authorityDurationMs?: number;
}

/**
 * Evaluation-only host wiring: each canary gets a prompt-bound, general-task
 * authority. The live adapter itself still never grants or widens authority.
 */
export function createPreAuthorizedLocalCanaryAdapter(
  input: LocalSafeCanaryHostOptions,
): CanaryAdapter {
  const now = input.now ?? (() => new Date());
  const authorityDurationMs = input.authorityDurationMs ?? 10 * 60_000;
  const runtime = createLocalSafeCanaryRuntime(input);
  return createSafeLiveCanaryAdapter({
    runtime,
    now,
    executionForCanary: (canary: CanaryCase) => {
      const taskId = `evaluation-${canary.id}`;
      const scope = createTaskAuthorityScope({
        taskId,
        goal: canary.prompt,
        taskKind: "general",
      });
      const decidedAt = now();
      return {
        kind: "general",
        taskId,
        authority: allowTaskAuthority(
          scope,
          decidedAt,
          new Date(decidedAt.getTime() + authorityDurationMs),
          "evaluation-only read-only canary scope",
        ),
      };
    },
  });
}
