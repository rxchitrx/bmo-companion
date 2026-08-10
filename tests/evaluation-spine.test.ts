import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canaryCases } from "../evaluation/canaries";
import { deterministicFixtureAdapter } from "../evaluation/fixtures";
import { toJson, toMarkdown } from "../evaluation/reporters";
import { runCanaries } from "../evaluation/runner";
import { validateEvaluationResult } from "../evaluation/schema";
import type { CanaryAdapter, EvaluationResult } from "../evaluation/types";

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
