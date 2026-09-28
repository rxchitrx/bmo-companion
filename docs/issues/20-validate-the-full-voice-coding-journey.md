# Validate the full voice coding journey

Status: Open for human macOS voice testing. Automated voice contracts and a live Pi/Python project flow pass, but they do not replace the spoken app walkthrough.

## What to build

Exercise a coding request in the actual macOS app from spoken project selection through approval, progress, cancellation or completion, review, and restart recovery. Record observable outcomes and fix failures found in the journey.

## Acceptance criteria

- [ ] A spoken request selects the intended saved project and shows its folder before approval.
- [ ] Approval starts one scoped Pi Task. Progress and final verification are visible and spoken concisely.
- [ ] Spoken Stop cancels the running Task and leaves partial work for review without replaying edits.
- [ ] Restart during approval, execution, or review restores a safe, understandable state.
- [ ] Ambiguous project names, a removed folder, microphone failure, worker crash, and failed tests have clear recovery paths.
- [ ] Evidence includes app-level traces and source-checkout checks for each scenario; unit tests alone do not count as the live walkthrough.

## Depends on

- [Select a project by voice](17-select-a-project-by-voice.md).
- [Review and apply code task results](18-review-and-apply-code-task-results.md).
