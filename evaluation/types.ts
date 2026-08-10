export const measurementStatuses = ["measured", "unsupported", "pending"] as const;

export type MeasurementStatus = (typeof measurementStatuses)[number];

export interface Measurement {
  status: MeasurementStatus;
  unit: "tokens" | "count" | "milliseconds";
  value?: number;
  note?: string;
}

export interface EvaluationOutcome {
  status: MeasurementStatus;
  verdict: "pass" | "fail" | "not-run";
  summary: string;
}

export interface VerificationEvidence {
  status: MeasurementStatus;
  kind: "fixture-event" | "fixture-output" | "runtime-event" | "runtime-output";
  detail: string;
}

export interface EvaluationResult {
  caseId: string;
  caseName: string;
  mode: "deterministic-fixture" | "live-runtime";
  input: Measurement;
  cachedInput: Measurement;
  freshInput: Measurement;
  output: Measurement;
  reasoning: Measurement;
  turns: Measurement;
  toolCalls: Measurement;
  latency: Measurement;
  outcome: EvaluationOutcome;
  verificationEvidence: VerificationEvidence[];
}

export interface CanaryExpectation {
  outputExact?: string;
  maxToolCalls?: number;
  requiredEvents?: string[];
  forbiddenEvents?: string[];
  connectorDiscoveryBytesMax?: number;
}

export interface CanaryCase {
  id: string;
  name: string;
  prompt: string;
  purpose: string;
  expectation: CanaryExpectation;
}

export interface CanaryObservation {
  outputText?: string;
  events: string[];
  toolCallNames: string[];
  connectorDiscoveryBytes?: number;
  telemetry?: Partial<{
    input: Measurement;
    cachedInput: Measurement;
    freshInput: Measurement;
    output: Measurement;
    reasoning: Measurement;
    turns: Measurement;
    toolCalls: Measurement;
    latency: Measurement;
  }>;
}

export interface CanaryAdapter {
  mode: EvaluationResult["mode"];
  run(canary: CanaryCase): Promise<CanaryObservation>;
}
