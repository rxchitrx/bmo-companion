## Parent

#1

## What to build

Type: AFK

Demonstrate Work Priority by delivering an urgent deadline Signal while a Mac-control Task is active. BMO notifies the owner according to Attention Mode and asks whether to continue or cancel the active Task rather than silently preempting the desktop.

User stories covered: 25–27, 57–67.

## Acceptance criteria

- [ ] Signals are event-driven, deduplicated, and classified without continuous model polling.
- [ ] Live commands, urgent signals, active Tasks, and ordinary directives follow the accepted Work Priority.
- [ ] An urgent signal can speak when the Attention Policy permits but cannot seize the active Mac-control lease.
- [ ] The owner can continue or cancel the active Task from the interruption prompt.
- [ ] Tests cover Normal, Focus, Quiet, and Away behavior plus conflicting Mac-control work.

## Blocked by

- #12 — Slice 11: Receive an opt-in Morning Briefing.
