import type {
  CanaryAdapter,
  CanaryCase,
  CanaryObservation,
  EvaluationResult,
  Measurement,
  VerificationEvidence,
} from "./types";

const missingTokens = (
  field: string,
  mode: EvaluationResult["mode"],
): Measurement => ({
  status: mode === "deterministic-fixture" ? "unsupported" : "pending",
  unit: "tokens",
  note:
    mode === "deterministic-fixture"
      ? `${field} attribution is not available from fixtures.`
      : `${field} attribution is awaiting live runtime telemetry.`,
});

const pendingLatency = (): Measurement => ({
  status: "pending",
  unit: "milliseconds",
  note: "Awaiting live runtime timing telemetry.",
});

function verify(
  canary: CanaryCase,
  observation: CanaryObservation,
  mode: EvaluationResult["mode"],
): VerificationEvidence[] {
  const evidence: VerificationEvidence[] = [];
  const expected = canary.expectation;
  const outputKind = mode === "deterministic-fixture" ? "fixture-output" : "runtime-output";
  const eventKind = mode === "deterministic-fixture" ? "fixture-event" : "runtime-event";

  if (expected.outputExact !== undefined) {
    evidence.push({
      status: "measured",
      kind: outputKind,
      detail:
        observation.outputText === expected.outputExact
          ? `Output matched ${JSON.stringify(expected.outputExact)}.`
          : `Output mismatch: expected ${JSON.stringify(expected.outputExact)}, received ${JSON.stringify(observation.outputText)}.`,
    });
  }

  if (expected.maxToolCalls !== undefined) {
    evidence.push({
      status: "measured",
      kind: eventKind,
      detail: `${observation.toolCallNames.length} tool calls observed; budget is ${expected.maxToolCalls}.`,
    });
  }

  for (const event of expected.requiredEvents ?? []) {
    evidence.push({
      status: "measured",
      kind: eventKind,
      detail: observation.events.includes(event)
        ? `Required event observed: ${event}.`
        : `Required event missing: ${event}.`,
    });
  }

  for (const event of expected.forbiddenEvents ?? []) {
    evidence.push({
      status: "measured",
      kind: eventKind,
      detail: observation.events.includes(event)
        ? `Forbidden event observed: ${event}.`
        : `Forbidden event absent: ${event}.`,
    });
  }

  if (expected.connectorDiscoveryBytesMax !== undefined) {
    const actual = observation.connectorDiscoveryBytes;
    evidence.push({
      status: actual === undefined ? "pending" : "measured",
      kind: eventKind,
      detail:
        actual === undefined
          ? "Connector discovery payload size is awaiting runtime telemetry."
          : `Connector discovery payload was ${actual} bytes; budget is ${expected.connectorDiscoveryBytesMax}.`,
    });
  }

  return evidence;
}

function passed(canary: CanaryCase, observation: CanaryObservation): boolean {
  const expected = canary.expectation;
  return (
    (expected.outputExact === undefined || observation.outputText === expected.outputExact) &&
    (expected.maxToolCalls === undefined || observation.toolCallNames.length <= expected.maxToolCalls) &&
    (expected.requiredEvents ?? []).every((event) => observation.events.includes(event)) &&
    (expected.forbiddenEvents ?? []).every((event) => !observation.events.includes(event)) &&
    (expected.connectorDiscoveryBytesMax === undefined ||
      (observation.connectorDiscoveryBytes !== undefined &&
        observation.connectorDiscoveryBytes <= expected.connectorDiscoveryBytesMax))
  );
}

export async function runCanary(
  canary: CanaryCase,
  adapter: CanaryAdapter,
): Promise<EvaluationResult> {
  const observation = await adapter.run(canary);
  const telemetry = observation.telemetry ?? {};
  const verdict = passed(canary, observation) ? "pass" : "fail";

  return {
    caseId: canary.id,
    caseName: canary.name,
    mode: adapter.mode,
    input: telemetry.input ?? missingTokens("Input-token", adapter.mode),
    cachedInput:
      telemetry.cachedInput ?? missingTokens("Cached-input", adapter.mode),
    freshInput:
      telemetry.freshInput ?? missingTokens("Fresh-input", adapter.mode),
    output: telemetry.output ?? missingTokens("Output-token", adapter.mode),
    reasoning:
      telemetry.reasoning ?? missingTokens("Reasoning-token", adapter.mode),
    turns:
      telemetry.turns ??
      (adapter.mode === "deterministic-fixture"
        ? { status: "measured", unit: "count", value: 1 }
        : {
            status: "pending",
            unit: "count",
            note: "Turn count is awaiting live runtime telemetry.",
          }),
    toolCalls:
      telemetry.toolCalls ?? {
        status: "measured",
        unit: "count",
        value: observation.toolCallNames.length,
      },
    latency: telemetry.latency ?? pendingLatency(),
    outcome: {
      status: "measured",
      verdict,
      summary:
        adapter.mode === "deterministic-fixture"
          ? `${verdict === "pass" ? "Passed" : "Failed"} deterministic ${canary.name} contract; this is not a live runtime result.`
          : `${verdict === "pass" ? "Passed" : "Failed"} live runtime ${canary.name} canary.`,
    },
    verificationEvidence: verify(canary, observation, adapter.mode),
  };
}

export async function runCanaries(
  canaries: readonly CanaryCase[],
  adapter: CanaryAdapter,
): Promise<EvaluationResult[]> {
  return Promise.all(canaries.map((canary) => runCanary(canary, adapter)));
}
