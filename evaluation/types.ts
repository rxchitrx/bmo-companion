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

export type CanaryOutputContract = "short-greeting";

export interface CanaryExpectation {
  outputExact?: string;
  /** A bounded semantic shape for live-model output with valid wording variance. */
  outputContract?: CanaryOutputContract;
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
  /** Set when the opt-in adapter could not safely run the canary. */
  skipped?: {
    reason: string;
  };
  /** The kernel's verifier result, when a live runtime reached settlement. */
  runtimeOutcome?: "verified" | "unverified";
  /** Additional runtime/kernel evidence retained by the live adapter. */
  verificationEvidence?: VerificationEvidence[];
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
  /** Live adapters may serialize runs to bound quota and runtime concurrency. */
  serial?: boolean;
  run(canary: CanaryCase): Promise<CanaryObservation>;
}
