import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { canaryCases } from "./canaries";
import { validateEvaluationResult } from "./schema";
import type { EvaluationResult, EvaluationRun, EvaluationSeries, Measurement } from "./types";

const modelMeasuredCaseIds = ["zero-tool-startup", "ordinary-conversation"];
const tokenFields = ["input", "cachedInput", "freshInput", "output", "reasoning"] as const;
const metrics = [...tokenFields, "turns", "toolCalls", "latency"] as const;
type Metric = typeof metrics[number];

export interface ExperimentSettings {
  mode: EvaluationResult["mode"];
  runtime: string;
  model: string;
  reasoningEffort: string;
  configurationFingerprint: string;
  evaluationFingerprint: string;
  codeRevision: string;
}

export function gitRevision(cwd: string): string {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, encoding: "utf8" });
    if (!status) return head;
    const diff = execFileSync("git", ["diff", "HEAD", "--binary"], { cwd });
    const fingerprint = createHash("sha256").update(status).update(diff).digest("hex");
    return `${head}+dirty:${fingerprint}`;
  }
  catch { return "unknown"; }
}

export async function evaluationFingerprint(cwd: string): Promise<string> {
  // Pin the full evaluation protocol, including parsing, validation, and comparison.
  const files = [
    "evaluation/canaries.ts", "evaluation/cli.ts", "evaluation/comparison.ts",
    "evaluation/evaluation-result.schema.json", "evaluation/evaluation-series.schema.json",
    "evaluation/experiment.ts", "evaluation/fixtures.ts", "evaluation/live-adapter.ts",
    "evaluation/local-host.ts", "evaluation/local-runtime.ts", "evaluation/reporters.ts",
    "evaluation/runner.ts", "evaluation/schema.ts", "evaluation/types.ts",
  ];
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update(await readFile(resolve(cwd, file)));
  }
  return hash.digest("hex");
}

export function makeRun(results: EvaluationResult[], repetition: number, settings: ExperimentSettings): EvaluationRun {
  return {
    schemaVersion: "2.0",
    metadata: {
      runId: randomUUID(), createdAt: new Date().toISOString(), repetition,
      canarySet: canaryCases.map((item) => item.id),
      modelMeasuredCaseIds: settings.mode === "live-runtime" ? modelMeasuredCaseIds : [],
      ...settings,
    },
    results,
  };
}

function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function measured(value: Measurement): value is Measurement & { value: number } {
  return value?.status === "measured" && typeof value.value === "number" &&
    Number.isFinite(value.value) && value.value >= 0;
}
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function validateSeries(value: unknown): EvaluationSeries {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a versioned evaluation series object.");
  const series = value as EvaluationSeries;
  if (series.schemaVersion !== "2.0" || !Array.isArray(series.runs) || series.runs.length < 1) {
    throw new Error("Expected schemaVersion 2.0 with at least one run.");
  }
  const ids = new Set<string>();
  const reference = series.runs[0]!.metadata;
  const firstNames = series.runs[0]!.results?.map((result) => result.caseName);
  for (const [index, run] of series.runs.entries()) {
    if (run?.schemaVersion !== "2.0" || !run.metadata || !Array.isArray(run.results)) throw new Error(`Run ${index + 1} is malformed.`);
    const meta = run.metadata;
    for (const key of ["runId", "createdAt", "runtime", "model", "reasoningEffort", "codeRevision", "configurationFingerprint", "evaluationFingerprint"] as const) {
      if (typeof meta[key] !== "string" || !meta[key]) throw new Error(`Run ${index + 1} lacks ${key}.`);
    }
    if (ids.has(meta.runId)) throw new Error(`Duplicate runId ${meta.runId}.`);
    ids.add(meta.runId);
    if (meta.repetition !== index + 1) throw new Error(`Run ${index + 1} has an invalid repetition number.`);
    if (!Array.isArray(meta.canarySet) || !Array.isArray(meta.modelMeasuredCaseIds)) throw new Error("Canary metadata is malformed.");
    for (const key of ["mode", "runtime", "model", "reasoningEffort", "codeRevision", "configurationFingerprint", "evaluationFingerprint", "canarySet", "modelMeasuredCaseIds"] as const) {
      if (!equal(meta[key], reference[key])) throw new Error(`Repeated runs differ in ${key}.`);
    }
    if (run.results.length !== meta.canarySet.length || !equal(run.results.map((result) => result.caseId), meta.canarySet)) {
      throw new Error(`Run ${index + 1} does not match its declared canary set.`);
    }
    if (!equal(run.results.map((result) => result.caseName), firstNames)) throw new Error("Case names differ across repetitions.");
    for (const result of run.results) {
      const errors = validateEvaluationResult(result);
      if (errors.length) throw new Error(`Run ${index + 1}, ${result.caseId}: ${errors.join(" ")}`);
      if (result.mode !== meta.mode) throw new Error(`Run ${index + 1} mixes evaluation modes.`);
    }
    if (meta.modelMeasuredCaseIds.some((id) => !meta.canarySet.includes(id))) throw new Error("Model measured case is absent from canary set.");
    if (meta.mode === "live-runtime" && !equal(meta.modelMeasuredCaseIds, modelMeasuredCaseIds)) {
      throw new Error("Live run must declare the two model-measured canaries.");
    }
  }
  return series;
}

export interface MetricSummary {
  status: "improved" | "regressed" | "unchanged" | "unavailable";
  baseline?: { median: number; min: number; max: number; samples: number };
  candidate?: { median: number; min: number; max: number; samples: number };
  note?: string;
}
export interface SeriesComparison {
  schemaVersion: "2.0";
  baseline: { label: string; repetitions: number; codeRevision: string };
  candidate: { label: string; repetitions: number; codeRevision: string };
  overallVerdict: "regression" | "incomplete" | "no-regression";
  cases: Array<{ caseId: string; caseName: string; outcomes: { baseline: string[]; candidate: string[] }; metrics: Record<Metric, MetricSummary> }>;
}

function summarize(values: number[]) {
  return { median: median(values), min: Math.min(...values), max: Math.max(...values), samples: values.length };
}

export function compareSeries(baseline: EvaluationSeries, candidate: EvaluationSeries, labels: { baseline: string; candidate: string }): SeriesComparison {
  validateSeries(baseline); validateSeries(candidate);
  const a = baseline.runs[0]!.metadata;
  const b = candidate.runs[0]!.metadata;
  if (baseline.runs.length !== candidate.runs.length || baseline.runs.length < 3) {
    throw new Error("Comparison requires at least three repetitions and equal sample counts on both sides.");
  }
  const baselineRunIds = new Set(baseline.runs.map((run) => run.metadata.runId));
  if (candidate.runs.some((run) => baselineRunIds.has(run.metadata.runId))) {
    throw new Error("Baseline and candidate contain the same run sample.");
  }
  for (const key of ["mode", "runtime", "model", "reasoningEffort", "configurationFingerprint", "evaluationFingerprint", "canarySet", "modelMeasuredCaseIds"] as const) {
    if (!equal(a[key], b[key])) throw new Error(`Incomparable runs: ${key} differs.`);
  }
  if (a.mode !== "live-runtime") throw new Error("Token efficiency comparison requires live-runtime runs.");
  let incomplete = false;
  let regression = false;
  const cases = a.canarySet.map((caseId, caseIndex) => {
    const baseResults = baseline.runs.map((run) => run.results[caseIndex]!);
    const nextResults = candidate.runs.map((run) => run.results[caseIndex]!);
    if (baseResults[0]!.caseName !== nextResults[0]!.caseName) throw new Error(`Case name differs for ${caseId}.`);
    const baseOutcomes = baseResults.map((result) => result.outcome.verdict);
    const nextOutcomes = nextResults.map((result) => result.outcome.verdict);
    if (baseOutcomes.some((value) => value !== "pass") || nextOutcomes.some((value) => value !== "pass")) {
      if (nextOutcomes.some((value) => value === "fail")) regression = true;
      else incomplete = true;
    }
    const caseMetrics = Object.fromEntries(metrics.map((metric) => {
      const relevant = !tokenFields.includes(metric as typeof tokenFields[number]) || a.modelMeasuredCaseIds.includes(caseId);
      const base = baseResults.map((result) => result[metric]);
      const next = nextResults.map((result) => result[metric]);
      if (!relevant) return [metric, { status: "unavailable", note: "Local safety path does not call a model." }];
      if (![...base, ...next].every(measured)) {
        incomplete = true;
        return [metric, { status: "unavailable", note: "At least one repetition lacks measured telemetry." }];
      }
      const baseSummary = summarize(base.map((item) => item.value!));
      const nextSummary = summarize(next.map((item) => item.value!));
      const status = nextSummary.median < baseSummary.median ? "improved" : nextSummary.median > baseSummary.median ? "regressed" : "unchanged";
      if (status === "regressed") regression = true;
      return [metric, { status, baseline: baseSummary, candidate: nextSummary }];
    })) as Record<Metric, MetricSummary>;
    return { caseId, caseName: nextResults[0]!.caseName, outcomes: { baseline: baseOutcomes, candidate: nextOutcomes }, metrics: caseMetrics };
  });
  return {
    schemaVersion: "2.0",
    baseline: { label: labels.baseline, repetitions: baseline.runs.length, codeRevision: a.codeRevision },
    candidate: { label: labels.candidate, repetitions: candidate.runs.length, codeRevision: b.codeRevision },
    overallVerdict: regression ? "regression" : incomplete ? "incomplete" : "no-regression",
    cases,
  };
}

export function seriesMarkdown(series: EvaluationSeries): string {
  const meta = series.runs[0]!.metadata;
  const lines = ["# BMO Canary Evaluation", "", `Mode: ${meta.mode}; runtime: ${meta.runtime}; model: ${meta.model}; effort: ${meta.reasoningEffort}`,
    `Revision: ${meta.codeRevision}; configuration: ${meta.configurationFingerprint}; repetitions: ${series.runs.length}`, ""];
  for (const run of series.runs) {
    lines.push(`## Repetition ${run.metadata.repetition} (${run.metadata.runId})`, "");
    for (const result of run.results) lines.push(`- ${result.caseId}: **${result.outcome.verdict}**; input ${result.input.status === "measured" ? result.input.value : result.input.status}; output ${result.output.status === "measured" ? result.output.value : result.output.status}`);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

export function comparisonMarkdown(comparison: SeriesComparison): string {
  const lines = ["# BMO Canary Comparison", "", `Verdict: **${comparison.overallVerdict}**`,
    `Baseline: ${comparison.baseline.label} (${comparison.baseline.repetitions} runs, ${comparison.baseline.codeRevision})`,
    `Candidate: ${comparison.candidate.label} (${comparison.candidate.repetitions} runs, ${comparison.candidate.codeRevision})`, ""];
  for (const item of comparison.cases) {
    lines.push(`## ${item.caseName}`, "", `Outcomes: ${item.outcomes.baseline.join(", ")} → ${item.outcomes.candidate.join(", ")}`, "", "| Metric | Baseline median [min, max] | Candidate median [min, max] | Status |", "| --- | ---: | ---: | --- |");
    for (const metric of metrics) {
      const value = item.metrics[metric];
      const display = (summary?: MetricSummary["baseline"]) => summary ? `${summary.median} [${summary.min}, ${summary.max}]` : "unavailable";
      lines.push(`| ${metric} | ${display(value.baseline)} | ${display(value.candidate)} | ${value.status} |`);
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}
