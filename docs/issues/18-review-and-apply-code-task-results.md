# Review and apply code task results

Status: Planned. Follows voice-controlled project selection.

## What to build

After Pi finishes in an isolated worktree, show the changed files, diff, test evidence, and any verification limits in BMO. The owner can explicitly apply the result to the selected project or discard the isolated result.

## Acceptance criteria

- [ ] The result screen shows the selected project, changed files, readable diff, verification status, and original test output summary.
- [ ] Apply rechecks the selected project identity, base commit, and current checkout state. A conflict or changed base enters Needs Decision without overwriting owner work.
- [ ] Discard cleans up only the Task's isolated worktree after direct owner action; it never deletes source-checkout files.
- [ ] Failed or unverified work is clearly labeled and remains available for inspection.
- [ ] Commit, push, pull request creation, and publishing remain separate confirmed actions.
- [ ] Automated and live app checks cover apply, discard, conflicts, changed checkout, interrupted apply, and restart recovery.

## Depends on

- [Select a project by voice](17-select-a-project-by-voice.md).
