import type { EvaluationResult, Measurement } from "./types";
import type {
  EvaluationComparison,
  MeasurementComparison,
} from "./comparison";

function display(measurement: Measurement): string {
  return measurement.status === "measured"
    ? `${measurement.value} ${measurement.unit}`
    : `${measurement.status}${measurement.note ? ` — ${measurement.note}` : ""}`;
}

export function toJson(results: readonly EvaluationResult[]): string {
  return `${JSON.stringify(results, null, 2)}\n`;
}

export function toMarkdown(results: readonly EvaluationResult[]): string {
  const sections = results.map((result) => {
    const rows = [
      ["Input", result.input],
      ["Cached input", result.cachedInput],
      ["Fresh input", result.freshInput],
      ["Output", result.output],
      ["Reasoning", result.reasoning],
      ["Turns", result.turns],
      ["Tool calls", result.toolCalls],
      ["Latency", result.latency],
    ] as const;
    const evidence = result.verificationEvidence
      .map((item) => `- [${item.status}] ${item.detail}`)
      .join("\n");

    return [
      `## ${result.caseName}`,
      "",
      `- Case: \`${result.caseId}\``,
      `- Mode: \`${result.mode}\``,
      `- Outcome: **${result.outcome.verdict}** — ${result.outcome.summary}`,
      "",
      "| Field | Result |",
      "| --- | --- |",
      ...rows.map(([name, value]) => `| ${name} | ${display(value)} |`),
      "",
      "Verification evidence:",
      "",
      evidence,
    ].join("\n");
  });

  return ["# BMO Canary Evaluation", "", ...sections].join("\n\n") + "\n";
}

function comparisonDisplay(comparison: MeasurementComparison): string {
  const baseline = display(comparison.baseline);
  const candidate = display(comparison.candidate);
  const delta = comparison.delta === undefined ? "" : `; delta ${comparison.delta >= 0 ? "+" : ""}${comparison.delta}`;
  return `${baseline} → ${candidate} [${comparison.status}${delta}]`;
}

export function toComparisonJson(comparison: EvaluationComparison): string {
  return `${JSON.stringify(comparison, null, 2)}\n`;
}

export function toComparisonMarkdown(comparison: EvaluationComparison): string {
  const sections = comparison.cases.map((item) => [
    `## ${item.caseName}`,
    "",
    `- Case: \`${item.caseId}\``,
    `- Outcome: ${item.outcome.baseline.verdict} → ${item.outcome.candidate.verdict} [${item.outcome.status}]`,
    "",
    "| Field | Baseline → Candidate |",
    "| --- | --- |",
    ...([
      ["Input", item.metrics.input],
      ["Cached input", item.metrics.cachedInput],
      ["Fresh input", item.metrics.freshInput],
      ["Output", item.metrics.output],
      ["Reasoning", item.metrics.reasoning],
      ["Turns", item.metrics.turns],
      ["Tool calls", item.metrics.toolCalls],
      ["Latency", item.metrics.latency],
    ] as const).map(([name, value]) => `| ${name} | ${comparisonDisplay(value)} |`),
    "",
    `Verification evidence: ${item.verificationEvidence.baseline.length} → ${item.verificationEvidence.candidate.length} [${item.verificationEvidence.status}]`,
  ].join("\n"));

  return [
    "# BMO Canary Baseline/Candidate Comparison",
    "",
    `- Baseline: **${comparison.baseline.label}**`,
    `- Candidate: **${comparison.candidate.label}**`,
    `- Overall: **${comparison.overallVerdict}**`,
    `- Cases: ${comparison.summary.caseCount}; improved ${comparison.summary.improved}; regressed ${comparison.summary.regressed}; unchanged ${comparison.summary.unchanged}; unavailable ${comparison.summary.unavailable}`,
    "",
    ...sections,
  ].join("\n\n") + "\n";
}
