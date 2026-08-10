import { canaryCases } from "./canaries";
import { deterministicFixtureAdapter } from "./fixtures";
import { toJson, toMarkdown } from "./reporters";
import { runCanaries } from "./runner";
import { validateEvaluationResult } from "./schema";

const format = process.argv.includes("--json") ? "json" : "markdown";
const results = await runCanaries(canaryCases, deterministicFixtureAdapter);
const errors = results.flatMap((result) =>
  validateEvaluationResult(result).map((error) => `${result.caseId}: ${error}`),
);

if (errors.length > 0) {
  throw new Error(`Invalid evaluation results:\n${errors.join("\n")}`);
}

process.stdout.write(format === "json" ? toJson(results) : toMarkdown(results));
