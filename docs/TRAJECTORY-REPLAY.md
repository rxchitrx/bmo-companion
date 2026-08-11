# Privacy-safe trajectory tracing and replay

`electron/trajectory.ts` defines the versioned `bmo.trajectory` contract. A
`TrajectoryRecorder` accepts existing Task Context Packet metadata, kernel
lifecycle events, selected capabilities, cumulative usage snapshots, guardrail
outcomes, verification evidence, and owner corrections.

The record is intentionally metadata-only:

- Task ids, goals, progress, guardrail summaries, verification statements, and
  owner corrections are stored as character/byte counts plus SHA-256 digests.
- Context segments retain provenance, measurement status, bounded sizes, and
  hashes; they never retain the segment value.
- Capability ids and bounded policy/status labels are retained because they are
  decision metadata. Connector arguments, tool results, credentials, prompts,
  transcripts, and screenshots are not accepted by the contract.
- Usage is recorded as deltas from cumulative snapshots, preserving resets as a
  new baseline rather than producing negative numbers.

`TrajectoryRecorder.recordKernelEvent()` maps the existing typed kernel event
union to safe metadata. It does not subscribe to the runtime or start a new
execution path; a future composition layer may call it from an existing event
observer.

## Deterministic replay

`replayTrajectory()` applies the saved event path to a small state machine and a
named fixture. It checks approval before worker start, terminal transitions,
required/forbidden events, and correction paths. The replay result explicitly
reports zero tool executions, zero live-service calls, and zero Computer Use
calls.

The Python Reliability Lab consumes the same JSON shape:

```bash
python3 -m reliability_lab replay \
  reliability_lab/fixtures/trajectory-verified-completion.json \
  --fixture verified-completion
python3 -m reliability_lab replay \
  reliability_lab/fixtures/trajectory-verified-completion.json \
  --fixture verified-completion --json
```

Replay is a contract check for a saved decision path. A passing replay is not a
claim that the original live Task succeeded, and it must never be used as a
shortcut around owner approval or recovery revalidation.

## Safe integration

1. Keep trajectory capture behind an explicit event-observer or export step.
2. Never add raw prompt/output/tool payloads to the JSON record to make a test
   easier; add a bounded metadata field or digest instead.
3. Keep fixture replay separate from live canaries, Electron startup, personal
   connectors, browser access, and Computer Use.
4. Add a new schema/replay version when the record contract changes. Do not
   silently reinterpret a saved `1.0` record.
