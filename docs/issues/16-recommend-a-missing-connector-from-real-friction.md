## Parent

#1

## What to build

Type: AFK

After repeated Tasks encounter the same missing capability, let BMO detect the friction, vet a relevant public connector, and present either an immediate recommendation or a Capability Digest entry. It must never install, authorize, or expand the connector itself.

User stories covered: 75–77.

## Acceptance criteria

- [ ] Repeated task friction creates a deduplicated capability-discovery signal with supporting evidence.
- [ ] Capability Vetting reports provenance, scopes, maintenance, license, and risk before recommendation.
- [ ] A blocked/current need surfaces immediately; lower-priority findings enter the digest.
- [ ] Installation, OAuth connection, and scope expansion each require direct owner approval.
- [ ] Tests cover friction thresholds, vetting, recommendation timing, deduplication, and prohibition of automatic connection.

## Blocked by

- #12 — Slice 11: Receive an opt-in Morning Briefing.
- #15 — Slice 14: Teach BMO a corrected workflow.
