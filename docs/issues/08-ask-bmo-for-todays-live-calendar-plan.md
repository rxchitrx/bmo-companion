## Parent

#1

## What to build

Type: AFK

Let the Companion Owner connect Google Calendar through an available Codex app/plugin or official MCP path, inspect its granted read scope and status, and ask BMO for a live plan grounded in the canonical calendar.

User stories covered: 38, 73–74, 78.

## Acceptance criteria

- [ ] The owner explicitly connects Calendar and sees scopes, read/write capability, connection time, status, last use, and revoke control.
- [ ] A read-only planning request retrieves current Calendar data without a consequential Task Approval.
- [ ] The resulting plan cites live source references and stores only bounded learned context.
- [ ] Revocation or scope loss suspends only Calendar-dependent work and asks the owner to reconnect.
- [ ] Tests cover connection, live read, canonical-source behavior, revocation, and narrow degradation.

## Blocked by

- #6 — Slice 5: Recall a completed task from last week.
