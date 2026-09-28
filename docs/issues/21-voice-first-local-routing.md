# Voice-first companion with local routing

Status: Implemented as a guarded pilot. Human voice walkthrough remains open.

## Goal

BMO opens with voice as the primary action and keeps typing available. Its live session carries the active project and Task context. A local Laya classifier can flag a likely mismatch between the spoken request and the tool route that Codex proposes.

## Current behavior

- Start voice is the primary control; Type instead opens the existing text path.
- The selected project is saved and available to the live voice tools. BMO resolves aliases against saved entries; the model cannot provide an arbitrary project path.
- `npm run setup:laya` installs a pinned local checkpoint. It uses no model API. If unavailable, BMO continues with the existing Codex voice path.
- Laya cannot approve a Task or invoke a tool. A strong disagreement asks the user to clarify before task dispatch. It does not silently redirect a request.
- Voice and typed coding tasks use the same selected-project snapshot and approval boundary.

## Validation still needed

- A human microphone walkthrough across project switch, coding request, stop, review, and restart.
- A larger labeled voice routing set before Laya can become the primary autonomous router. The current 30-example synthetic lab reached 24/30 correct; that does not establish production accuracy.
- Voice token usage remains unreported by the current Codex realtime transport; this feature does not claim token savings.
