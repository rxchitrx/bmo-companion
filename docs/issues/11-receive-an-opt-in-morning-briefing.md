## Parent

#1

## What to build

Type: AFK

Let the Companion Owner activate a Morning Briefing Directive with a configured trigger. At that time BMO combines live Calendar, Todoist priorities, and important Gmail into a concise spoken briefing while preserving connector and Attention Policy boundaries.

User stories covered: 57–65, 79.

## Acceptance criteria

- [ ] The owner explicitly activates, configures, pauses, resumes, and disables the Morning Briefing Directive.
- [ ] The trigger creates a Directive Task with only the authority explicitly granted by the directive.
- [ ] The briefing uses current Calendar, Todoist, and Gmail data and speaks a concise summary according to Attention Mode.
- [ ] Missing/degraded connectors are reported without disabling the remaining briefing sources.
- [ ] Tests cover trigger matching, explicit activation, attention behavior, partial degradation, and directive lifecycle.

## Blocked by

- #10 — Slice 9: Turn BMO’s plan into a Todoist action.
- #11 — Slice 10: Use important Gmail in a planning conversation.
