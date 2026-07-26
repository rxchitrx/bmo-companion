## Parent

#1

## What to build

Type: AFK

Make an approved Task durable across unanswered decisions, app-server interruption, app restart, and Mac lock. BMO reminds the owner about pending decisions, restores Task context, re-observes external state, revalidates authority, and never blindly replays prior desktop actions.

User stories covered: 21–24, 35–37, 67.

## Acceptance criteria

- [ ] Pending approvals and Needs Decision states generate reminders at 2, 5, and 10 minutes, then on a slower Attention-Policy-aware cadence.
- [ ] A two-hour Task Approval maximum is enforced and extension requires direct confirmation.
- [ ] Restart Recovery restores durable context but re-observes current state and revalidates scope before any further action.
- [ ] Mac-control work suspends while the execution surface is unavailable and resumes only with valid authority.
- [ ] Repeated failed Directive Tasks pause their directive instead of retrying indefinitely.
- [ ] Tests cover restart idempotency, approval expiry, suspension/resume, and absence of action replay.

## Blocked by

- #2 — Slice 1: BMO completes one approved desktop task.
