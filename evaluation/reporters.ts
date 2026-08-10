import type { EvaluationResult, Measurement } from "./types";

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
