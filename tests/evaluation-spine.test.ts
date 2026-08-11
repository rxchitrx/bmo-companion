import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canaryCases } from "../evaluation/canaries";
import { compareEvaluationRuns } from "../evaluation/comparison";
import { deterministicFixtureAdapter } from "../evaluation/fixtures";
import { createSafeLiveCanaryAdapter, type SafeCanaryRuntime } from "../evaluation/live-adapter";
import { createPreAuthorizedLocalCanaryAdapter } from "../evaluation/local-host";
import {
  toComparisonMarkdown,
  toJson,
  toMarkdown,
} from "../evaluation/reporters";
import { runCanaries } from "../evaluation/runner";
import { validateEvaluationResult } from "../evaluation/schema";
import type { CanaryAdapter, EvaluationResult } from "../evaluation/types";
import {
  allowTaskAuthority,
  createTaskAuthorityScope,
} from "../electron/permission-lifecycle";

test("the permanent spine defines exactly the five baseline canaries", () => {
  assert.deepEqual(
    canaryCases.map((canary) => canary.id),
    [
      "zero-tool-startup",
      "ordinary-conversation",
      "approval-pause",
      "stop-cancel",
      "connector-discovery-budget",
    ],
  );
});

test("deterministic fixtures produce valid results without invented live telemetry", async () => {
  const results = await runCanaries(canaryCases, deterministicFixtureAdapter);

  assert.equal(results.length, 5);
  for (const result of results) {
    assert.deepEqual(validateEvaluationResult(result), []);
    assert.equal(result.mode, "deterministic-fixture");
    assert.equal(result.outcome.verdict, "pass");
    assert.equal(result.input.status, "unsupported");
    assert.equal(result.cachedInput.status, "unsupported");
    assert.equal(result.freshInput.status, "unsupported");
    assert.equal(result.output.status, "unsupported");
    assert.equal(result.reasoning.status, "unsupported");
    assert.equal(result.latency.status, "pending");
    assert.equal("value" in result.input, false);
    assert.match(result.outcome.summary, /not a live runtime result/);
  }
});

test("machine and human reports contain every required result field", async () => {
  const [result] = await runCanaries([canaryCases[0]], deterministicFixtureAdapter);
  const json = JSON.parse(toJson([result])) as Record<string, unknown>[];
  const markdown = toMarkdown([result]);

  for (const field of [
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
  ]) {
    assert.ok(field in json[0], field);
  }
  assert.match(markdown, /Cached input/);
  assert.match(markdown, /Verification evidence/);
  assert.match(markdown, /unsupported/);
});

test("the runner fails a canary when its deterministic contract is violated", async () => {
  const failingAdapter: CanaryAdapter = {
    mode: "deterministic-fixture",
    async run() {
      return { outputText: "WRONG", events: [], toolCallNames: ["unexpected_tool"] };
    },
  };
  const [result] = await runCanaries([canaryCases[0]], failingAdapter);

  assert.equal(result.outcome.verdict, "fail");
  assert.match(result.verificationEvidence[0].detail, /Output mismatch/);
});

test("ordinary live conversation uses a bounded greeting contract", async () => {
  const canary = canaryCases.find((item) => item.id === "ordinary-conversation")!;
  const runWithOutput = (outputText: string): CanaryAdapter => ({
    mode: "live-runtime",
    async run() {
      return {
        outputText,
        events: ["turn-complete"],
        toolCallNames: [],
        runtimeOutcome: "verified",
      };
    },
  });

  const [conciseGreeting] = await runCanaries([canary], runWithOutput("Hello!"));
  assert.equal(conciseGreeting.outcome.verdict, "pass");
  assert.match(conciseGreeting.verificationEvidence[0]?.detail ?? "", /short single-line greeting/);

  const [unrelatedOutput] = await runCanaries([canary], runWithOutput("The task is complete."));
  assert.equal(unrelatedOutput.outcome.verdict, "fail");
  assert.match(unrelatedOutput.verificationEvidence[0]?.detail ?? "", /Output mismatch/);
});

test("result validation rejects a measured field without a value", async () => {
  const [result] = await runCanaries([canaryCases[0]], deterministicFixtureAdapter);
  const invalid: EvaluationResult = {
    ...result,
    turns: { status: "measured", unit: "count" },
  };

  assert.deepEqual(validateEvaluationResult(invalid), [
    "turns.value is required when status is measured.",
  ]);
});

test("JSON Schema requires every evaluation field", async () => {
  const schemaPath = new URL("../evaluation/evaluation-result.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(schemaPath, "utf8")) as { required: string[] };

  assert.deepEqual(schema.required, [
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
  ]);
});

test("opt-in live mode stays honest and does not invoke an unconfigured runtime", async () => {
  const results = await runCanaries(canaryCases, createSafeLiveCanaryAdapter());

  assert.equal(results.length, 5);
  for (const result of results) {
    assert.deepEqual(validateEvaluationResult(result), []);
    assert.equal(result.mode, "live-runtime");
    assert.equal(result.outcome.status, "pending");
    assert.equal(result.outcome.verdict, "not-run");
    assert.equal(result.input.status, "pending");
    assert.equal(result.toolCalls.status, "pending");
    assert.match(result.outcome.summary, /No safe live runtime was configured/);
    assert.equal(result.verificationEvidence[0]?.status, "pending");
  }
});

test("safe live adapter routes pre-authorized runtime telemetry through kernel verification", async () => {
  const canary = canaryCases.find((item) => item.id === "approval-pause")!;
  const now = new Date("2026-01-01T09:00:00.000Z");
  const scope = createTaskAuthorityScope({
    taskId: "live-canary-test",
    goal: canary.prompt,
    taskKind: "general",
  });
  const execution = {
    kind: "general" as const,
    taskId: "live-canary-test",
    authority: allowTaskAuthority(
      scope,
      now,
      new Date("2026-01-01T11:00:00.000Z"),
    ),
  };
  let calls = 0;
  const runtime: SafeCanaryRuntime = {
    async run(context) {
      calls += 1;
      context.turnStarted();
      context.event("approval-requested");
      return {
        summary: "Waiting for approval.",
        outputText: "Waiting for approval.",
        verified: true,
        verificationEvidence: [{
          id: "live.worker-contract",
          kind: "worker-contract",
          source: "safe-canary-runtime",
          polarity: "supports",
          strength: "direct",
          statement: "The safe canary runtime stopped at the approval boundary.",
        }],
        usage: {
          inputTokens: 24,
          cachedInputTokens: 9,
          outputTokens: 8,
          reasoningOutputTokens: 3,
          totalTokens: 35,
        },
        timing: {
          startupMs: 2,
          executionMs: 7,
          settlingMs: 1,
          shutdownMs: 1,
          totalMs: 11,
        },
      };
    },
  };

  const [result] = await runCanaries([canary], createSafeLiveCanaryAdapter({
    runtime,
    execution,
    now: () => now,
  }));

  assert.equal(calls, 1);
  assert.equal(result.outcome.verdict, "pass");
  assert.equal(result.input.value, 24);
  assert.equal(result.cachedInput.value, 9);
  assert.equal(result.freshInput.value, 15);
  assert.equal(result.output.value, 8);
  assert.equal(result.reasoning.value, 3);
  assert.equal(result.turns.value, 1);
  assert.equal(result.toolCalls.value, 0);
  assert.equal(result.latency.value, 11);
  assert.ok(result.verificationEvidence.some((item) => /Kernel verifier decision: verified/.test(item.detail)));
  assert.deepEqual(validateEvaluationResult(result), []);
});

test("safe live adapter refuses connector/computer execution before calling the runtime", async () => {
  const canary = canaryCases[0]!;
  let calls = 0;
  const now = new Date("2026-01-01T09:00:00.000Z");
  const connectorCall = {
    service: "personal-mail",
    action: "send",
    mode: "write" as const,
    arguments: {},
    label: "Personal mail",
  };
  const connectorScope = createTaskAuthorityScope({
    taskId: "blocked-live-canary",
    goal: canary.prompt,
    taskKind: "connector",
    connectorCall,
  });
  const runtime: SafeCanaryRuntime = {
    async run() {
      calls += 1;
      return { summary: "unexpected", verified: true };
    },
  };
  const result = await runCanaries([canary], createSafeLiveCanaryAdapter({
    runtime,
    execution: {
      kind: "connector",
      connectorCall,
      taskId: "blocked-live-canary",
      authority: allowTaskAuthority(
        connectorScope,
        now,
        new Date("2026-01-01T11:00:00.000Z"),
      ),
    },
  }));

  assert.equal(calls, 0);
  assert.equal(result[0]?.outcome.verdict, "not-run");
  assert.match(result[0]?.outcome.summary ?? "", /outside the safe/);
});

test("live telemetry carries turn budgets into the integrated guardrail", async () => {
  const canary = canaryCases[0]!;
  const now = new Date("2026-01-01T09:00:00.000Z");
  const scope = createTaskAuthorityScope({
    taskId: "guarded-live-canary",
    goal: canary.prompt,
    taskKind: "general",
  });
  const runtime: SafeCanaryRuntime = {
    async run(context) {
      context.turnStarted();
      context.turnStarted();
      return { summary: "late result", verified: true };
    },
  };
  const [result] = await runCanaries([canary], createSafeLiveCanaryAdapter({
    runtime,
    budgets: { maxTurns: 1 },
    execution: {
      kind: "general",
      taskId: "guarded-live-canary",
      authority: allowTaskAuthority(
        scope,
        now,
        new Date("2026-01-01T11:00:00.000Z"),
      ),
    },
    now: () => now,
  }));

  assert.equal(result.outcome.verdict, "fail");
  assert.equal(result.toolCalls.value, 0);
  assert.ok(result.verificationEvidence.some((item) => /guardrail triggered: turns/.test(item.detail)));
});

test("comparison output keeps unavailable metrics and exposes audit fields", async () => {
  const [baseline] = await runCanaries([canaryCases[0]!], deterministicFixtureAdapter);
  const candidate: EvaluationResult = {
    ...baseline,
    turns: { status: "measured", unit: "count", value: 2 },
  };
  const comparison = compareEvaluationRuns([baseline], [candidate], {
    baseline: "before",
    candidate: "after",
  });

  assert.equal(comparison.overallVerdict, "regression");
  assert.equal(comparison.cases[0]?.metrics.turns.status, "regressed");
  assert.equal(comparison.cases[0]?.metrics.input.status, "unavailable");
  assert.match(toComparisonMarkdown(comparison), /Fresh input/);
  assert.match(toComparisonMarkdown(comparison), /Verification evidence/);
});

test("local safe host covers non-model safety canaries without service access", async () => {
  const selected = canaryCases.filter((item) => [
    "approval-pause",
    "stop-cancel",
    "connector-discovery-budget",
  ].includes(item.id));
  const results = await runCanaries(selected, createPreAuthorizedLocalCanaryAdapter({
    cwd: process.cwd(),
    now: () => new Date("2026-01-01T09:00:00.000Z"),
  }));

  assert.deepEqual(results.map((result) => result.outcome.verdict), ["pass", "pass", "pass"]);
  assert.deepEqual(results.map((result) => result.toolCalls.value), [0, 0, 1]);
  assert.equal(results[2]?.latency.status, "measured");
  assert.ok(results[2]?.verificationEvidence.some((item) => /Kernel verifier decision: verified/.test(item.detail)));
  for (const result of results) {
    assert.equal(result.input.status, "pending");
    assert.equal(result.output.status, "pending");
    assert.deepEqual(validateEvaluationResult(result), []);
  }
});
