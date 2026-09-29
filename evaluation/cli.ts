import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { canaryCases } from "./canaries";
import { deterministicFixtureAdapter } from "./fixtures";
import { createPreAuthorizedLocalCanaryAdapter } from "./local-host";
import { runCanaries } from "./runner";
import { compareSeries, comparisonMarkdown, evaluationFingerprint, gitRevision, makeRun, seriesMarkdown, validateSeries } from "./experiment";
import type { EvaluationSeries } from "./types";

const originalConsoleLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("[BMO-DIAG]")) console.error(...args);
  else originalConsoleLog(...args);
};

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

const format = process.argv.includes("--json") ? "json" : "markdown";
if (process.argv.includes("--live")) {
  throw new Error("--live has no runtime and cannot produce a baseline. Use --live-local-safe with explicit --model, --effort, and --config-id.");
}

if (process.argv.includes("--compare")) {
  const baselinePath = argumentValue("--baseline");
  const candidatePath = argumentValue("--candidate");
  if (!baselinePath || !candidatePath) throw new Error("--compare requires --baseline and --candidate JSON files.");
  const [baseline, candidate] = await Promise.all([baselinePath, candidatePath].map(async (path) =>
    validateSeries(JSON.parse(await readFile(path, "utf8")))));
  const comparison = compareSeries(baseline, candidate, { baseline: baselinePath, candidate: candidatePath });
  process.stdout.write(format === "json" ? `${JSON.stringify(comparison, null, 2)}\n` : comparisonMarkdown(comparison));
  if (comparison.overallVerdict !== "no-regression") process.exitCode = 1;
} else {
  const cwd = process.cwd();
  const localSafe = process.argv.includes("--live-local-safe");
  const repeatText = argumentValue("--repeat") ?? "1";
  const repeat = Number(repeatText);
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 20) throw new Error("--repeat must be an integer from 1 to 20.");
  const model = argumentValue("--model");
  const effort = argumentValue("--effort");
  const configId = argumentValue("--config-id");
  if (localSafe && (!model || !effort || !configId)) {
    throw new Error("--live-local-safe requires --model, --effort, and --config-id to record comparable settings.");
  }
  const codexPath = process.env.CODEX_CLI_PATH ?? [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    join(homedir(), ".local/bin/codex"),
  ].find(existsSync) ?? "/Applications/ChatGPT.app/Contents/Resources/codex";
  const runtime = localSafe
    ? `codex-app-server:${createHash("sha256").update(await readFile(codexPath)).digest("hex")}`
    : "deterministic-fixture";
  const configPath = resolve(process.env.CODEX_HOME ?? resolve(homedir(), ".codex"), "config.toml");
  const configBytes = localSafe ? await readFile(configPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }) : Buffer.alloc(0);
  const configurationFingerprint = createHash("sha256")
    .update(configId ?? "fixture-default").update("\0").update(configBytes).digest("hex");
  const settings = {
    mode: localSafe ? "live-runtime" as const : "deterministic-fixture" as const,
    runtime, model: model ?? "none", reasoningEffort: effort ?? "none",
    configurationFingerprint,
    evaluationFingerprint: await evaluationFingerprint(cwd),
    codeRevision: gitRevision(cwd),
  };
  const adapter = localSafe
    ? createPreAuthorizedLocalCanaryAdapter({ cwd, codexPath, model, reasoningEffort: effort })
    : deterministicFixtureAdapter;
  const series: EvaluationSeries = { schemaVersion: "2.0", runs: [] };
  for (let repetition = 1; repetition <= repeat; repetition++) {
    const results = await runCanaries(canaryCases, adapter);
    series.runs.push(makeRun(results, repetition, settings));
  }
  validateSeries(series);
  process.stdout.write(format === "json" ? `${JSON.stringify(series, null, 2)}\n` : seriesMarkdown(series));
  if (series.runs.some((run) => run.results.some((result) =>
    result.outcome.verdict !== "pass" || result.outcome.status !== "measured" ||
    (localSafe && [result.turns, result.toolCalls, result.latency].some((field) => field.status !== "measured")) ||
    (run.metadata.modelMeasuredCaseIds.includes(result.caseId) &&
      [result.input, result.cachedInput, result.freshInput, result.output, result.reasoning].some((field) => field.status !== "measured"))))) {
    process.exitCode = 1;
  }
}
