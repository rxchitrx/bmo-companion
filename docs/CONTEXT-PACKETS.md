# Minimal Task Context Packets

BMO sends each managed Codex Task a typed, purpose-bound `TaskContextPacket`.
The production builder and renderer live in `electron/context-packet.ts`; the
managed Task transport consumes them in `electron/codex-adapter.ts`.

## Included by default

- The approved Task objective, capped at 20,000 characters.
- One capability reference selected from the Task kind: baseline worker,
  workspace work, or Computer Use.
- A manifest recording source, provenance, inclusion reason, size, and whether
  truncation occurred.
- A 22,000-character content budget with exact used and remaining counts.

No ambient conversation history, personal memory, environment dump, connector
catalog, or connector result is included in a managed Task packet by default.
Capability references are routing hints, not authority grants or dynamic tool
loading.

## Retry history boundary

Only an explicit retry may add history. It receives the previous Task's existing
outcome summary, never raw conversation or action history. The summary is marked
as untrusted data, stripped of null characters, and capped at 2,000 characters.
If needed, a Unicode-safe head/tail boundary keeps the beginning and latest
outcome while adding a visible truncation marker.

## Telemetry and privacy

Task 1 context attribution telemetry measures each selected packet field. Logs
contain provenance, inclusion reason, budget, truncation state, character/byte
counts, and hashes. The goal and retry summary themselves are not recorded.
Codex-owned inherited runtime context remains explicitly reported as unknown.

This slice does not change voice/conversation sessions, load tools dynamically,
change approval or lifecycle behavior, add evaluation canaries, or refactor the
broader runtime.
