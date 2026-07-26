## Parent

#1

## What to build

Type: AFK

Let the Companion Owner explicitly enable Screen Awareness for the active display, receive a persistent visible indicator, ask a question grounded in permitted screen context, and verify that Protected Surfaces and raw-frame retention rules are enforced.

User stories covered: 47–48, 59–60.

## Acceptance criteria

- [ ] Screen Awareness remains off until explicit opt-in and is visibly indicated while active.
- [ ] BMO can answer a bounded question using permitted active-screen context.
- [ ] Password managers, secure input, banking/financial apps, private browsing, and auth/recovery surfaces are excluded by default.
- [ ] Raw frames are discarded after processing unless the owner explicitly pins an Artifact.
- [ ] Tests cover opt-in state, indication, protected-surface filtering, answer grounding, and evidence expiry.

## Blocked by

- #5 — Slice 4: BMO survives an interrupted task safely.
