## Parent

#1

## What to build

Type: AFK

Extend the live plan so BMO can connect Todoist, propose one concrete task change, request scoped write approval, perform the change through the Personal Account, and verify the authoritative Todoist result.

User stories covered: 19–24, 73–74, 78.

## Acceptance criteria

- [ ] The owner explicitly connects Todoist and can inspect/revoke its scopes.
- [ ] BMO can read relevant tasks and propose a bounded Todoist write from the live plan.
- [ ] The write waits for a Task-scoped approval and does not reuse Calendar read authority.
- [ ] Completion requires live verification that Todoist reflects the requested change.
- [ ] Tests cover approval, denial, verified write, revocation, and connector degradation.

## Blocked by

- #9 — Slice 8: Ask BMO for today’s live Calendar plan.
