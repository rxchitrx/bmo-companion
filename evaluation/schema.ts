import { measurementStatuses, type EvaluationResult, type Measurement } from "./types";

const resultFields = [
  "caseId",
  "caseName",
  "mode",
  "input",
  "cachedInput",
  "freshInput",
  "output",
  "reasoning",
  "turns",
  "toolCalls",
  "latency",
  "outcome",
  "verificationEvidence",
] as const;

function validateMeasurement(name: string, measurement: Measurement, errors: string[]): void {
  if (!measurement || typeof measurement !== "object") {
    errors.push(`${name} is missing or invalid.`);
    return;
  }
  if (!measurementStatuses.includes(measurement.status)) {
    errors.push(`${name}.status is invalid.`);
  }
  if (measurement.status === "measured" && measurement.value === undefined) {
    errors.push(`${name}.value is required when status is measured.`);
  }
  if (measurement.status !== "measured" && measurement.value !== undefined) {
    errors.push(`${name}.value must be omitted when status is ${measurement.status}.`);
  }
  if (measurement.status === "measured" && measurement.value !== undefined &&
      (!Number.isFinite(measurement.value) || (measurement.value ?? -1) < 0)) {
    errors.push(`${name}.value must be a finite non-negative number.`);
  }
}

export function validateEvaluationResult(result: EvaluationResult): string[] {
  const errors: string[] = [];
  for (const field of resultFields) {
    if (!(field in result)) errors.push(`Missing required field: ${field}.`);
  }

  for (const field of [
    "input",
    "cachedInput",
    "freshInput",
    "output",
    "reasoning",
    "turns",
    "toolCalls",
    "latency",
  ] as const) {
    validateMeasurement(field, result[field], errors);
  }

  if (!result.outcome || !Array.isArray(result.verificationEvidence)) {
    errors.push("outcome or verificationEvidence is missing or invalid.");
    return errors;
  }
  if (result.outcome.status === "measured" && result.outcome.verdict === "not-run") {
    errors.push("A measured outcome cannot have a not-run verdict.");
  }
  if (result.verificationEvidence.length === 0) {
    errors.push("verificationEvidence must contain at least one item.");
  }
  return errors;
}
