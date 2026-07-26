## Parent

#1

## What to build

Type: AFK

After completing a Task, let the Companion Owner ask a natural follow-up days later and receive an answer grounded in local episodic/semantic memory and source references. External systems remain canonical and raw source content is not mirrored by default.

User stories covered: 38–42, 49–50, 80–82.

## Acceptance criteria

- [ ] A completed Task produces bounded episodic, semantic, and Artifact Reference candidates tied to its Ledger entry.
- [ ] A later Conversation Turn retrieves only relevant memories and references without injecting full history.
- [ ] Low-sensitivity, high-confidence, corroborated candidates may promote; sensitive or uncertain candidates remain reviewable.
- [ ] The answer identifies its supporting Task/source references and does not depend on retained raw External Source content.
- [ ] Tests cover relevant recall, irrelevant-memory exclusion, candidate gating, and local-only storage boundaries.

## Blocked by

- #2 — Slice 1: BMO completes one approved desktop task.
