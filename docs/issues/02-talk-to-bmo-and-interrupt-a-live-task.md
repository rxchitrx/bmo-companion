## Parent

#1

## What to build

Type: AFK

Extend the first Task loop so the Companion Owner can start a visible Listening Session using local “Hey BMO” activation or push-to-talk, hear concise spoken progress and completion, and interrupt the active Task by voice without changing the Companion identity or Task history.

User stories covered: 7–9, 33–34.

## Acceptance criteria

- [ ] Local wake activation or push-to-talk visibly opens a Listening Session before audio is sent.
- [ ] A spoken goal enters the existing general Task path and BMO speaks concise progress and the Completion Brief.
- [ ] A spoken Stop cancels the Task, revokes remaining authority, and prevents automatic resume without claiming to undo completed actions.
- [ ] Voice transport failure enters Degraded Conversation while preserving Task and conversation continuity.
- [ ] Tests cover activation, interruption, spoken completion, and fallback behavior through observable events.

## Blocked by

- #2 — Slice 1: BMO completes one approved desktop task.
