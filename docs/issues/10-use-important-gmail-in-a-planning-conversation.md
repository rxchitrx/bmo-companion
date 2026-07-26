## Parent

#1

## What to build

Type: AFK

Let the Companion Owner connect Gmail and ask a planning question that uses important live mail context alongside Calendar. BMO retrieves only relevant messages, explains the supporting references, and avoids creating a local mailbox mirror.

User stories covered: 38, 73–74, 78.

## Acceptance criteria

- [ ] The owner explicitly connects Gmail and sees/revokes the granted scope.
- [ ] A read-only planning Task retrieves bounded relevant mail and Calendar context.
- [ ] BMO’s answer includes source references and does not persist raw message bodies by default.
- [ ] Gmail revocation suspends only Gmail-dependent work while unrelated planning remains available.
- [ ] Tests cover relevance filtering, source references, evidence expiry, and narrow degradation.

## Blocked by

- #9 — Slice 8: Ask BMO for today’s live Calendar plan.
