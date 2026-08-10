# Permanent Evaluation Spine

This scaffold makes five BMO harness contracts repeatable before live telemetry is integrated:

1. Zero-tool startup.
2. Ordinary conversation.
3. Approval pause.
4. Stop/cancel.
5. Connector-discovery budget.

## Safe local use

The default runner uses deterministic fixtures. It does not start Electron, contact a model, access connectors, control the computer, or write outside standard process output.

```bash
npm run eval:canaries
npm run eval:canaries -- --json
```

The Markdown output is the human-readable report. `--json` emits results conforming to `evaluation/evaluation-result.schema.json`.

Fixture passes prove only the evaluation contract and runner behavior. They are not live model, voice, connector, approval, cancellation, latency, or token measurements.

Saved JSON results can be compared offline with the independent Python Reliability Lab. See `reliability_lab/README.md`; the lab never invokes this runner or the realtime runtime itself.

## Missing telemetry

Every result always contains:

- input, cached input, fresh input, output, and reasoning token measurements;
- turns and tool-call counts;
- latency and outcome;
- verification evidence.

A measurement has one of three statuses:

- `measured`: a value was observed by the active adapter;
- `unsupported`: the adapter cannot currently provide the measurement;
- `pending`: the integration point exists but awaits runtime telemetry.

Unsupported or pending measurements omit `value`; the runner never substitutes zero or a historical number.

## Integrating Task 1 telemetry

After Task 1 lands on `main`:

1. Rebase this branch onto the Task 1 commit and resolve only additive evaluation-file/package-script conflicts.
2. Add a separate `CanaryAdapter` implementation that invokes the telemetry-enabled runtime. Do not change the deterministic fixture adapter.
3. Map runtime usage snapshots to `input`, `cachedInput`, `freshInput`, `output`, and `reasoning`; map lifecycle/tool events to `turns`, `toolCalls`, `latency`, and `verificationEvidence`.
4. Keep a field `unsupported` or `pending` whenever Task 1 does not supply it. Do not infer missing values.
5. Run `npm run typecheck`, `npm test`, and both evaluation report formats. Compare fixture and live reports separately.

Live execution must remain opt-in because it can consume model quota and may exercise approval or connector boundaries. Never use personal connectors or Computer Use for the baseline fixture suite.
