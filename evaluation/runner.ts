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
  const outputKind = mode === "deterministic-fixture" ? "fixture-output" : "runtime-output";
  const eventKind = mode === "deterministic-fixture" ? "fixture-event" : "runtime-event";
  if (observation.skipped) {
    return [{
      status: "pending",
      kind: eventKind,
      detail: `Canary was not run: ${observation.skipped.reason}`,
    }];
  }

  const evidence: VerificationEvidence[] = [];
  const expected = canary.expectation;

  if (expected.outputExact !== undefined) {
    const status = observation.outputText === undefined && mode === "live-runtime"
      ? "pending"
      : "measured";
    evidence.push({
      status,
      kind: outputKind,
      detail:
        observation.outputText === undefined
          ? "Runtime output is awaiting live telemetry."
          : observation.outputText === expected.outputExact
          ? `Output matched ${JSON.stringify(expected.outputExact)}.`
          : `Output mismatch: expected ${JSON.stringify(expected.outputExact)}, received ${JSON.stringify(observation.outputText)}.`,
    });
  }

  if (expected.maxToolCalls !== undefined) {
    const status = observation.telemetry?.toolCalls?.status === "pending"
      ? "pending"
      : "measured";
    evidence.push({
      status,
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

  if (observation.runtimeOutcome === "unverified") {
    evidence.push({
      status: "measured",
      kind: "runtime-output",
      detail: "The integrated kernel verifier returned an unverified outcome.",
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

  return [...evidence, ...(observation.verificationEvidence ?? [])];
}

function passed(canary: CanaryCase, observation: CanaryObservation): boolean {
  if (observation.skipped || observation.runtimeOutcome === "unverified") return false;
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
  const skipped = observation.skipped !== undefined;
  const verdict = skipped ? "not-run" : passed(canary, observation) ? "pass" : "fail";
  const outcomeStatus = skipped ? "pending" : "measured";
  const pendingToolCalls = {
    status: "pending" as const,
    unit: "count" as const,
    note: "Tool-call count is unavailable because the live canary did not run.",
  };

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
      (skipped
        ? {
            status: "pending",
            unit: "count",
            note: "Turn count is unavailable because the live canary did not run.",
          }
        : adapter.mode === "deterministic-fixture"
        ? { status: "measured", unit: "count", value: 1 }
        : {
            status: "pending",
            unit: "count",
            note: "Turn count is awaiting live runtime telemetry.",
          }),
    toolCalls:
      telemetry.toolCalls ?? (skipped ? pendingToolCalls : {
        status: "measured",
        unit: "count",
        value: observation.toolCallNames.length,
      }),
    latency: telemetry.latency ?? pendingLatency(),
    outcome: {
      status: outcomeStatus,
      verdict,
      summary:
        skipped
          ? `Live runtime ${canary.name} was not run: ${observation.skipped?.reason}`
          : adapter.mode === "deterministic-fixture"
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
  if (adapter.serial) {
    const results: EvaluationResult[] = [];
    for (const canary of canaries) results.push(await runCanary(canary, adapter));
    return results;
  }
  return Promise.all(canaries.map((canary) => runCanary(canary, adapter)));
}
