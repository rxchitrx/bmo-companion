import type { EvaluationResult, Measurement, VerificationEvidence } from "./types";

export const comparisonMetrics = [
  "input",
  "cachedInput",
  "freshInput",
  "output",
  "reasoning",
  "turns",
  "toolCalls",
  "latency",
] as const;

export type ComparisonMetric = (typeof comparisonMetrics)[number];
export type ComparisonStatus =
  | "improved"
  | "regressed"
  | "unchanged"
  | "unavailable";

export interface MeasurementComparison {
  baseline: Measurement;
  candidate: Measurement;
  status: ComparisonStatus;
  note?: string;
  delta?: number;
  percentDelta?: number;
}

export interface EvidenceComparison {
  status: "unchanged" | "changed" | "unavailable";
  baseline: Array<Pick<VerificationEvidence, "kind" | "detail">>;
  candidate: Array<Pick<VerificationEvidence, "kind" | "detail">>;
  added: Array<Pick<VerificationEvidence, "kind" | "detail">>;
  removed: Array<Pick<VerificationEvidence, "kind" | "detail">>;
}

export interface EvaluationComparisonCase {
  caseId: string;
  caseName: string;
  metrics: Record<ComparisonMetric, MeasurementComparison>;
  outcome: {
    baseline: EvaluationResult["outcome"];
    candidate: EvaluationResult["outcome"];
    status: ComparisonStatus;
  };
  verificationEvidence: EvidenceComparison;
}

export interface EvaluationComparison {
  schemaVersion: "1.0";
  baseline: { label: string };
  candidate: { label: string };
  overallVerdict: "regression" | "incomplete" | "no-regression";
  summary: {
    caseCount: number;
    improved: number;
    regressed: number;
    unchanged: number;
    unavailable: number;
  };
  cases: EvaluationComparisonCase[];
}

function compareMeasurement(
  baseline: Measurement,
  candidate: Measurement,
): MeasurementComparison {
  if (baseline.status !== "measured" || candidate.status !== "measured") {
    return {
      baseline,
      candidate,
      status: "unavailable",
      note: `Requires two measured values; got ${baseline.status} and ${candidate.status}.`,
    };
  }
  const baselineValue = baseline.value ?? 0;
  const candidateValue = candidate.value ?? 0;
  const delta = candidateValue - baselineValue;
  return {
    baseline,
    candidate,
    status: delta < 0 ? "improved" : delta > 0 ? "regressed" : "unchanged",
    delta,
    ...(baselineValue !== 0
      ? { percentDelta: Math.round((delta / baselineValue) * 10000) / 100 }
      : {}),
  };
}

function compareOutcome(
  baseline: EvaluationResult["outcome"],
  candidate: EvaluationResult["outcome"],
): EvaluationComparisonCase["outcome"] {
  if (baseline.status !== "measured" || candidate.status !== "measured") {
    return { baseline, candidate, status: "unavailable" };
  }
  const rank = { "not-run": 0, fail: 1, pass: 2 } as const;
  const delta = rank[candidate.verdict] - rank[baseline.verdict];
  return {
    baseline,
    candidate,
    status: delta > 0 ? "improved" : delta < 0 ? "regressed" : "unchanged",
  };
}

function compareEvidence(
  baseline: VerificationEvidence[],
  candidate: VerificationEvidence[],
): EvidenceComparison {
  const simplify = (items: VerificationEvidence[]) =>
    items.map(({ kind, detail }) => ({ kind, detail }));
  const baselineItems = simplify(baseline);
  const candidateItems = simplify(candidate);
  const key = (item: { kind: string; detail: string }) => `${item.kind}\u0000${item.detail}`;
  const baselineKeys = new Set(baselineItems.map(key));
  const candidateKeys = new Set(candidateItems.map(key));
  const measured = [...baseline, ...candidate].every((item) => item.status === "measured");
  return {
    status: measured
      ? baselineKeys.size === candidateKeys.size &&
          [...baselineKeys].every((item) => candidateKeys.has(item))
        ? "unchanged"
        : "changed"
      : "unavailable",
    baseline: baselineItems,
    candidate: candidateItems,
    added: candidateItems.filter((item) => !baselineKeys.has(key(item))),
    removed: baselineItems.filter((item) => !candidateKeys.has(key(item))),
  };
}

function indexResults(results: readonly EvaluationResult[], label: string) {
  const indexed = new Map<string, EvaluationResult>();
  for (const result of results) {
    if (indexed.has(result.caseId)) throw new Error(`${label} contains duplicate caseId ${result.caseId}.`);
    indexed.set(result.caseId, result);
  }
  return indexed;
}

export function compareEvaluationRuns(
  baseline: readonly EvaluationResult[],
  candidate: readonly EvaluationResult[],
  labels: { baseline?: string; candidate?: string } = {},
): EvaluationComparison {
  if (baseline.length === 0 || candidate.length === 0) {
    throw new Error("Baseline and candidate runs must contain at least one result.");
  }
  const baselineById = indexResults(baseline, "Baseline");
  const candidateById = indexResults(candidate, "Candidate");
  const baselineIds = [...baselineById.keys()].sort();
  const candidateIds = [...candidateById.keys()].sort();
  if (baselineIds.join("\u0000") !== candidateIds.join("\u0000")) {
    throw new Error("Baseline and candidate case IDs differ.");
  }

  const counts = { improved: 0, regressed: 0, unchanged: 0, unavailable: 0 };
  const cases = baselineIds.map((caseId): EvaluationComparisonCase => {
    const base = baselineById.get(caseId)!;
    const next = candidateById.get(caseId)!;
    if (base.caseName !== next.caseName) throw new Error(`Case ${caseId} has different names.`);
    if (base.mode !== next.mode) throw new Error(`Case ${caseId} mixes evaluation modes.`);
    const metrics = Object.fromEntries(
      comparisonMetrics.map((metric) => {
        const comparison = compareMeasurement(base[metric], next[metric]);
        counts[comparison.status] += 1;
        return [metric, comparison];
      }),
    ) as Record<ComparisonMetric, MeasurementComparison>;
    const outcome = compareOutcome(base.outcome, next.outcome);
    counts[outcome.status] += 1;
    return {
      caseId,
      caseName: next.caseName,
      metrics,
      outcome,
      verificationEvidence: compareEvidence(base.verificationEvidence, next.verificationEvidence),
    };
  });

  return {
    schemaVersion: "1.0",
    baseline: { label: labels.baseline ?? "baseline" },
    candidate: { label: labels.candidate ?? "candidate" },
    overallVerdict: counts.regressed
      ? "regression"
      : counts.unavailable
        ? "incomplete"
        : "no-regression",
    summary: { caseCount: cases.length, ...counts },
    cases,
  };
}
