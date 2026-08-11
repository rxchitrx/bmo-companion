# Python Reliability Lab

This is a small, standard-library-only lab for comparing saved outputs from the permanent evaluation spine and replaying privacy-safe trajectory records. It is offline and read-only: it does not call models or APIs, start Electron, access connectors, use Computer Use, or write result files.

## Run the example

From the repository root:

```bash
python3 -m reliability_lab compare reliability_lab/scenarios/deterministic-example.json
python3 -m reliability_lab compare reliability_lab/scenarios/deterministic-example.json --json
```

The scorecard compares input, cached-input, fresh-input, output, and reasoning tokens; turns; tool calls; latency; outcome; and verification evidence. Lower measured resource values are treated as improvements. `unsupported` and `pending` remain unavailable rather than becoming zero. A regression exits with status 1; invalid input exits with status 2.

Fixture results prove only replay and comparison behavior. They are not live model or runtime measurements.

## Replay a trajectory

Trajectory records use schema `1.0`. They retain task/context metadata, lifecycle
decisions, selected capability ids, usage deltas, guardrail outcomes, bounded
verification evidence, and user-correction digests. Raw prompts, outputs, tool
arguments/results, personal data, and wall-clock payloads are not part of the
contract.

Replay applies the recorded decision path to a deterministic state-machine
fixture. It never starts a worker, calls a service, executes a tool, opens a
browser, or uses Computer Use.

```bash
python3 -m reliability_lab replay reliability_lab/fixtures/trajectory-verified-completion.json \
  --fixture verified-completion
python3 -m reliability_lab replay reliability_lab/fixtures/trajectory-verified-completion.json \
  --fixture verified-completion --json
```

Replay passes prove only that the saved decision path satisfies the fixture
contract. They are not evidence that the original live Task succeeded.

## Add a scenario

1. Save baseline and candidate JSON arrays produced by `npm run --silent eval:canaries -- --json`. Do not hand-convert missing telemetry to zero.
2. Copy `reliability_lab/scenarios/deterministic-example.json` and give it a unique `scenarioId` and name.
3. Point `baseline.results` and `candidate.results` to the saved files. Paths are relative to the scenario file.
4. Keep `schemaVersion` at `1.0` and point `evaluationResultSchema` at `evaluation/evaluation-result.schema.json`.
5. Run both scorecard and `--json` modes, then run the Python tests.

The scenario contract is documented in `reliability_lab/schemas/scenario-v1.schema.json`. Baseline and candidate must contain the same unique case IDs and conform to the evaluation spine fields consumed by comparison format 1.0.

The trajectory contract is documented in
`reliability_lab/schemas/trajectory-v1.schema.json`. Keep it versioned: add a
new schema and replay implementation when fields or privacy guarantees change;
never reinterpret a saved v1 record silently.

## Tests

```bash
npm run test:reliability
```

## Integration after the evaluation spine lands on `main`

Rebase this branch onto the main commit containing the spine. Resolve only additive conflicts under `evaluation/`, `reliability_lab/`, tests, documentation, and package scripts. No realtime production TypeScript needs to change.

Generate each saved run with the spine's JSON CLI and compare those files through a versioned scenario. If a future spine schema changes required fields or enums, add a new scenario/comparison version instead of silently reinterpreting v1 inputs. Keep live collection opt-in and separate; this lab only analyzes already-saved results.
