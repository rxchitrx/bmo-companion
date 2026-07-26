## Parent

#1

## What to build

Type: AFK

Let the Companion Owner say “show me” during a running Task to inspect its projected timeline, live permitted preview, and artifacts inside the Stage. Direct interaction remains disabled until Take Over explicitly ends BMO’s control.

User stories covered: 16–18, 31–32.

## Acceptance criteria

- [ ] Show Me opens a Task-specific timeline and available preview/artifact content without interrupting execution.
- [ ] The presented work surface is read-only while BMO retains Task control.
- [ ] Take Over revokes the relevant control lease before enabling direct user interaction.
- [ ] Hiding Show Me returns to the character without changing Task state.
- [ ] Tests prove read-only presentation, handoff ordering, and continued execution after hiding the view.

## Blocked by

- #2 — Slice 1: BMO completes one approved desktop task.
