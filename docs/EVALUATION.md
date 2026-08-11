# Permanent Evaluation Spine

This evaluation spine makes five BMO harness contracts repeatable and provides an opt-in live telemetry boundary:

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

## Safe live adapter

Live mode is explicit and has no default runtime:

```bash
npm run eval:canaries -- --live --json
```

Without an injected runtime, this command emits five `pending`/`not-run` results and invokes nothing. The host may inject a read-only `SafeCanaryRuntime` from `evaluation/live-adapter.ts`. It must pass a pre-authorized general-task `TaskExecutionOptions` scope. The adapter never creates authority, selects connector execution, supplies connector clients, uses Computer Use, or performs an external write. Connector discovery telemetry is limited to the explicitly allowlisted local `discover_services` event by default.

When a runtime is injected, the adapter routes it through `MinimalExecutionKernel`, captures kernel lifecycle events, uses the kernel verifier for settlement, and forwards turn/tool/usage callbacks to execution guardrails. Runtime fields that are not reported remain `pending`; no missing value is converted to zero.

## Before/after comparison

Save two JSON runs, then compare them with the same repeatable CLI:

```bash
npm run eval:canaries -- --live --json > before.json
npm run eval:canaries -- --live --json > after.json
npm run eval:canaries -- --compare --baseline before.json --candidate after.json
npm run eval:canaries -- --compare --baseline before.json --candidate after.json --json
```

The comparison includes total input, cached input, fresh input, output, reasoning, turns, tool calls, latency, outcome, and verification evidence. A metric is `unavailable` unless both sides are measured; `pending` and `unsupported` are retained in the baseline/candidate values. A regression is reported when a measured resource increases or the outcome moves from pass to fail. The command exits non-zero only for a measured regression; an incomplete comparison remains inspectable with an `incomplete` verdict.

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

## Integration contract for the Context Packet and execution kernel

The live adapter is deliberately a boundary layer; forthcoming Context Packet and execution-kernel work should preserve this contract:

1. `SafeCanaryRuntime` receives the canary prompt, an abort signal, progress/usage callbacks, and the kernel's pre-authorized execution options. It returns a summary, verification claim/evidence, optional timing, and bounded event telemetry.
2. The kernel remains the authority/lifecycle boundary. Context Packet construction and capability selection stay inside the kernel; the adapter observes them through lifecycle events and does not widen the packet or manifest.
3. Map runtime usage snapshots to `input`, `cachedInput`, `freshInput`, `output`, and `reasoning`; map explicit runtime/kernel events to `turns`, `toolCalls`, `latency`, and `verificationEvidence`.
4. Keep a field `unsupported` or `pending` whenever the runtime does not supply it. Do not infer missing values. A skipped live runtime is `outcome.status: pending` and `verdict: not-run`.
5. Keep live execution opt-in and safe: only a pre-authorized general task may run; connector calls, Computer Use, personal services, and external writes are outside this adapter contract.

The deterministic fixture adapter remains unchanged. Fixture execution never starts Electron, contacts a model, accesses connectors, controls the computer, or writes outside standard process output. Live execution can consume model quota and may exercise approval/cancellation boundaries, so run it only with a host runtime that satisfies the contract.
