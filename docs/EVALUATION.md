# Permanent Evaluation Spine

The five canaries cover zero-tool startup, ordinary conversation, approval pause, stop/cancel, and connector-discovery budget.

## Fixture check

```bash
npm run eval:canaries
npm run eval:canaries -- --json
```

Fixtures check the runner contract. They make no model or token measurements. JSON output is a version 2.0 series described by `evaluation/evaluation-series.schema.json`; each result still follows `evaluation/evaluation-result.schema.json`.

## Comparable local baseline

The former `--live` flag has no runtime and now exits with an error. Use the explicit local read-only host. Choose a model, effort, and stable configuration identifier, then keep all three identical for baseline and candidate. The identifier should describe the harness settings being held constant, not the code revision.

```bash
./node_modules/.bin/tsx evaluation/cli.ts --live-local-safe --model gpt-6-sol --effort medium --config-id standard-v1 --repeat 3 --json > /tmp/bmo-before.json
# Make the intended harness change.
./node_modules/.bin/tsx evaluation/cli.ts --live-local-safe --model gpt-6-sol --effort medium --config-id standard-v1 --repeat 3 --json > /tmp/bmo-after.json
npm run eval:canaries -- --compare --baseline /tmp/bmo-before.json --candidate /tmp/bmo-after.json
```

The local host sends the selected model and effort to Codex app-server. It starts an ephemeral read-only thread with apps disabled and approval requests declined. Only zero-tool startup and ordinary conversation use model turns and produce token measurements. Approval, stop/cancel, and discovery use bounded local safety paths; their token fields are not model measurements. This mode is opt-in and may consume model quota. It never uses a connector, browser, Computer Use, or an external write.

A series records each repetition, case set, mode, model, effort, executable SHA-256, evaluation-source SHA-256, a hash of the chosen configuration identifier and local Codex `config.toml`, and Git revision with a dirty-tree fingerprint when applicable. The comparator requires matching mode, runtime binary, model, effort, configuration fingerprint, evaluation source, canary set, and model-measured case set. It permits different Git revisions, because the candidate is expected to change code. Keep unrelated code/config changes out of the experiment. The CLI records the requested model/effort; the current protocol does not independently attest which model served the turn.

Comparison requires at least three repetitions per side and equal sample counts. It reports per-case medians and ranges so run-to-run noise is visible. A higher median resource count or candidate failure is a regression. Missing required measurements produce `incomplete`. A failing, not-run, or incomplete live run exits nonzero; comparison exits nonzero for regression or incomplete. Exit 0 means the measured contract passed under these checks, not that a small delta is statistically significant.

## Telemetry integrity

Missing or partial token usage stays pending. It is never converted to zero. The local app-server usage event must contain finite non-negative integer values for input, cached input, output, reasoning output, and total tokens, with cached input no greater than input. The comparator requires all repetitions of both model canaries to have measured token values. A true measured zero remains zero.

## Codex overhead lab

To estimate how much input comes from Codex's runtime versus BMO's typed-chat additions, run:

```bash
./node_modules/.bin/tsx evaluation/overhead-lab.ts > /tmp/bmo-codex-overhead.json
```

The lab runs five samples for each of three read-only arms: a minimal Codex prompt, BMO's current typed-chat instruction and empty Task state without dynamic tools, and the same BMO prompt with its current dynamic tool schemas. It rotates arm order and records individual input, cached-input, fresh-input, output, and timing samples. It uses the configured Codex model and effort by default; `BMO_EVAL_MODEL`, `BMO_EVAL_EFFORT`, and `BMO_EVAL_REPEAT` can override them. All tool requests are declined. The minimum arm estimates the app-server runtime floor; it does not expose or identify Codex's private system prompt. This lab measures typed chat, not realtime voice or multi-turn history.

Set `BMO_EVAL_ABLATION=1` to compare individual Codex startup settings against BMO's current typed-chat path. `BMO_EVAL_ABLATION_ARMS` selects named settings, and `BMO_EVAL_TOOL_PROBE=1` checks a single authorized task-state read. The lab saves progress to `/tmp/bmo-codex-ablation-progress.json` by default, records failed arms, and excludes incomplete arms from paired comparisons. See [the subscription token ablation report](./CODEX_SUBSCRIPTION_TOKEN_ABLATION.md) for the measured result and retained configuration.

The independent Python Reliability Lab reads the older per-result JSON array format. Its offline scenario comparison is separate from this version 2.0 repeated-series comparator; use `--compare` above for new series files. The result schema itself remains unchanged.

For privacy-safe lifecycle tracing and decision-path replay, see [TRAJECTORY-REPLAY.md](./TRAJECTORY-REPLAY.md).
