# Connector completion evidence

This matrix distinguishes implemented/tested behavior from account-dependent live authorization.

| Requirement | Authoritative implementation | Verification |
| --- | --- | --- |
| One connector/event architecture | `electron/connector-types.ts`, `connector-gateway.ts`, `connector-tools.ts` | Gateway discovery, schema and routing tests |
| Ordinary typed and realtime voice access | `conversation-client.ts`, `realtime-voice-client.ts` | Thread-policy tests, realtime discover/read/write test, real typed GitHub request |
| Reads without consequential authority | `ConnectorToolBridge.handle` | Direct-read test confirms no Task is created |
| Writes require one scoped approval | `TaskRuntime` connector Tasks | Approval/Verified Outcome lifecycle test |
| Approval, progress and terminal state reach speech | `CodexRealtimeVoiceClient.syncTask` | Realtime state and speech tests |
| Spoken Stop does not end voice | `enforceOwnerStop` | Voice remains connected after Task cancellation |
| Spoken Stop aborts connector reads and writes | `cancelActiveReads`, Task abort signal, command termination escalation | In-flight realtime read and connector write cancellation tests |
| No permanent deletion | No registered delete action; native bridge has no delete switch; 1Password has no model action | Actual 48-action surface prohibition test |
| External data cannot become instructions | Tool results and ambient events are marked untrusted; conversation prompts repeat the boundary | Authority-policy assertions |
| Proactive updates are token-efficient | Five deterministic CLI/API watches; no model polling | Default-watch test |
| Disconnected voice does not lose in-session updates | Bounded 50-item in-memory pending queue | Queue/flush-once test |
| Proactive notices reach live speech | Realtime `appendText` plus fixed `appendSpeech` for notification-class watches | Proactive realtime injection test |
| Secrets never reach the model | Todoist resolves only configured token or `op://` reference internally; 1Password publishes zero actions | Secret-boundary contract test |
| Capability reporting | `connectors:list` IPC and Connections panel | Live Electron visual check |
| Every named connector has contract coverage | `tests/connectors-contract.test.ts` | All 48 actions execute with fake native/CLI/API boundaries |

## Connector coverage

| Connector | Read/search | Safe writes/actions | Proactive |
| --- | --- | --- | --- |
| Apple Calendar | calendars, events | create/update event | next 24 hours |
| Apple Reminders | lists, reminders | create/update/complete | open reminders |
| Apple Contacts | search | create/update | — |
| Apple Notes | search/read | create/append | — |
| Apple Shortcuts | approved-folder list | run reviewed shortcut | — |
| Apple Music | now playing | play/pause/next/previous/play track | — |
| Files/Spotlight | local search | —; file mutation remains a scoped Codex Task | — |
| Google Workspace | Gmail/Drive/Docs/Sheets reads | send/upload/create/append | unread Gmail |
| Todoist | active tasks | create/update/complete | active tasks |
| GitHub | issues/PRs/notifications | comment/create issue | notifications |
| Obsidian | search/read | create/append | — |
| 1Password | no model-visible vault read | internal explicit-reference resolution only | — |

## Account-dependent gates

The code and mocks are complete, but real external writes cannot be truthfully certified until the owner authorizes the relevant account and approves a harmless smoke action:

- macOS Calendar, Reminders and Contacts privacy grants
- Notes and Music automation grants
- a reviewed `BMO Approved` Shortcuts folder
- `gog` OAuth for the selected Google account
- Todoist token or explicit 1Password reference
- Obsidian 1.12.7+ CLI registration
- 1Password CLI sign-in when `op://` references are used

GitHub read access is live-verified through the authenticated `gh` session.
