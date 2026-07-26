## Parent

#1

## What to build

Type: AFK

Let BMO inspect, modify, and test a repository in an Isolated Workspace under one approved Code Task. Local verification may complete autonomously; commit, push, pull-request creation, publishing, and deployment remain Reserved Actions.

User stories covered: 54–56.

## Acceptance criteria

- [ ] A code goal creates an Isolated Workspace without modifying unrelated dirty work.
- [ ] Codex can inspect, edit, run proportionate tests, and report a Verified Outcome inside that workspace.
- [ ] A dirty or non-isolatable repository enters Needs Decision before modification.
- [ ] Commit, push, pull-request creation, publish, and deploy each require fresh direct confirmation.
- [ ] Tests cover workspace isolation, dirty-tree handling, local verification, and Reserved Action enforcement.

## Blocked by

- #5 — Slice 4: BMO survives an interrupted task safely.
