# Select a project by voice

Status: Planned. This is the next coding workflow milestone; implementation has not started.

## What to build

Let the owner register a local project once with a native folder picker and give it a spoken name. Later, a request such as “work on Moksh and fix the login bug” selects that saved project before BMO creates a coding Task. “Switch to Moksh” changes the active project without starting a Task. The Stage always shows the selected project and folder before approval.

## Acceptance criteria

- [ ] The owner can add, rename, inspect, and remove saved project entries. Registration uses a native folder picker; the model cannot invent or register a filesystem path.
- [ ] Typed and spoken coding requests resolve a saved project by stable ID and spoken aliases. Ambiguous or unknown names trigger a clarification or folder picker, never a guessed folder.
- [ ] A project switch alone does not approve or start a coding Task.
- [ ] The coding Task and scoped approval record the project ID, canonical Git root, and starting commit. BMO shows these before approval and rechecks them before creating the isolated worktree.
- [ ] Non-Git folders and dirty repositories enter Needs Decision with a clear next action; BMO does not silently edit the original folder or discard changes.
- [ ] The Pi worker receives only the selected worktree. Voice and typed requests use the same selection and authorization path.
- [ ] Tests cover aliases, ambiguity, stale or missing folders, symlink/path changes, project switching during an active Task, approval mismatch, dirty checkout, and restart recovery.
- [ ] A live macOS walkthrough confirms: register folder, select by voice, approve, run, stop, and review the result without changing another project.

## Related work

After selection, finish the [owner-facing code review flow](18-review-and-apply-code-task-results.md): show changed files and verification evidence, then let the owner apply or discard the isolated result explicitly. Commit, push, and publishing remain separately confirmed actions.

## Current boundary

The voice tool currently supplies only a goal and Task kind. The coding executor currently uses the process's project directory and requires a clean Git root. See `electron/realtime-voice-client.ts`, `electron/task-runtime.ts`, and `electron/code-workspace.ts`.
