# Verify code tasks across project types

Status: Implemented with approved Node, Python unittest, and pytest presets. Automated tests and live isolated Node and Python tasks pass. BMO's own `npm test` suite cannot pass inside its verifier sandbox because several tests start another macOS sandbox; that coding Task correctly stays unverified. See `outputs/evaluation/pi-coding-nested-sandbox-2026-09-28.json`. A safe check strategy for projects that test sandboxes themselves remains open.

## What to build

Make BMO's independent code verification work for approved projects beyond those with an `npm test` script. Keep the verifier separate from Pi's model turn and preserve an explicit unverified outcome when no trustworthy check is available.

## Acceptance criteria

- [ ] Each saved project has a visible, owner-approved verification command or supported preset; BMO never runs an unreviewed model-supplied command as verification.
- [ ] Verification has a bounded runtime, isolated execution, clear exit status, and evidence linked to the code Task.
- [ ] A missing or failing check produces an explicit unverified result, not a pass or a zero-token placeholder.
- [ ] Tests cover at least a Node project, a Python project, no configured check, timeout, cancellation, and a verifier that modifies files.
- [ ] Repeated live tasks demonstrate that source checkouts remain untouched until an owner-approved apply step.

## Related work

- [Review and apply code task results](18-review-and-apply-code-task-results.md).
