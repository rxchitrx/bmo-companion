import { readFile } from "node:fs/promises";
import { canaryCases } from "./canaries";
import { compareEvaluationRuns } from "./comparison";
import { deterministicFixtureAdapter } from "./fixtures";
import { createSafeLiveCanaryAdapter } from "./live-adapter";
import {
  toComparisonJson,
  toComparisonMarkdown,
  toJson,
  toMarkdown,
} from "./reporters";
import { runCanaries } from "./runner";
import { validateEvaluationResult } from "./schema";

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const format = process.argv.includes("--json") ? "json" : "markdown";
const baselinePath = argumentValue("--baseline");
const candidatePath = argumentValue("--candidate");

if (process.argv.includes("--compare")) {
  if (!baselinePath || !candidatePath) {
    throw new Error("--compare requires --baseline <json> and --candidate <json>.");
  }
  const [baselineValue, candidateValue] = await Promise.all([
    readFile(baselinePath, "utf8"),
    readFile(candidatePath, "utf8"),
  ]);
  const baseline = JSON.parse(baselineValue) as Parameters<typeof compareEvaluationRuns>[0];
  const candidate = JSON.parse(candidateValue) as Parameters<typeof compareEvaluationRuns>[1];
  const validationErrors = [
    ...baseline.flatMap((result) =>
      validateEvaluationResult(result).map((error) => `baseline ${result.caseId}: ${error}`),
    ),
    ...candidate.flatMap((result) =>
      validateEvaluationResult(result).map((error) => `candidate ${result.caseId}: ${error}`),
    ),
  ];
  if (validationErrors.length > 0) {
    throw new Error(`Invalid comparison input:\n${validationErrors.join("\n")}`);
  }
  const comparison = compareEvaluationRuns(baseline, candidate, {
    baseline: baselinePath,
    candidate: candidatePath,
  });
  process.stdout.write(format === "json"
    ? toComparisonJson(comparison)
    : toComparisonMarkdown(comparison));
  if (comparison.overallVerdict === "regression") process.exitCode = 1;
} else {
  const live = process.argv.includes("--live");
  const adapter = live
    ? createSafeLiveCanaryAdapter()
    : deterministicFixtureAdapter;
  const results = await runCanaries(canaryCases, adapter);
  const errors = results.flatMap((result) =>
    validateEvaluationResult(result).map((error) => `${result.caseId}: ${error}`),
  );

  if (errors.length > 0) {
    throw new Error(`Invalid evaluation results:\n${errors.join("\n")}`);
  }

  process.stdout.write(format === "json" ? toJson(results) : toMarkdown(results));
}
