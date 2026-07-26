## Parent

#1

## What to build

Type: AFK

After the Companion Owner corrects a completed Task, let BMO create, test, version, and later apply a Procedure candidate that improves planning and verification without encoding UI coordinates, shortcuts, new permissions, or self-installed code.

User stories covered: 43–46.

## Acceptance criteria

- [ ] A corrected Task trajectory produces a reviewable Procedure candidate linked to evidence.
- [ ] The candidate is tested against a replay/evaluation before activation and retains rollback history.
- [ ] Applying the Procedure to a similar Task improves context/planning/verification while Codex still observes and chooses current actions.
- [ ] Procedures cannot add tools, connectors, permissions, Reserved Actions, hardcoded UI recipes, or active code changes.
- [ ] Tests cover candidate generation, rejection, activation, rollback, later reuse, and authority non-expansion.

## Blocked by

- #6 — Slice 5: Recall a completed task from last week.
- #8 — Slice 7: BMO completes a safe isolated code task.
