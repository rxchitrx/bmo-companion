# BMO interaction router

BMO owns one current owner turn across voice and typed input. The Codex realtime session provides speech and conversation, and Pi remains the isolated coding worker. Neither provider decides whether its own tool call is authorized.

## Flow

1. A direct owner transcript or typed request starts a BMO turn. Starting another turn invalidates the previous turn and cancels active connector reads.
2. BMO checks narrow, explicit intent rules and optionally asks the local Laya classifier. A strong disagreement asks for clarification. Laya does not grant tools or create Tasks.
3. Voice tools, typed connector tools, the typed Task button, and explicit typed actions check the same current turn. Clear typed requests for coding, browser, computer, project switch, or Stop are handled by BMO without a conversational model turn. Connector schemas are discovered only for the owner's active service request. Service writes and coding/computer/browser work enter the existing scoped Task approval lifecycle.
4. BMO suppresses accidental duplicate Tasks, requires a finished Task for an explicit retry, and binds project selection to saved project entries.
5. BMO persists at most 12 short owner/assistant entries in a private local file. The opposite input mode receives up to six recent entries plus the active project name. A completed typed turn also updates an open voice session without triggering speech. These entries supply context only; restart never restores tool authority.

## Safety boundaries

- A turn expires after two minutes. A stale voice or typed tool call is denied. Vague requests do not authorize tools, and the typed Task control explicitly supplies its selected Task kind.
- A voice project switch must name the saved project that is selected. BMO prevents competing Task creations and does not reuse a completed coding Task after the active project changes.
- The model cannot register a project path, grant approval, or bypass the final tool risk policy.
- Connector service details remain behind `discover_services`; only selected action names and schemas enter that turn's context.
- BMO keeps authoritative Task state in `TaskRuntime` and injects it separately from conversational history.
- The local Laya evaluation currently supports only clarification on disagreement. Autonomous routing requires a larger labeled evaluation.
- This change has no measured token reduction. The existing model-backed canaries must be compared under the same Codex binary, model, effort, and configuration before making an efficiency claim.

## Checks

`tests/interaction-router.test.ts` covers shared history/restart, invalid-session recovery, stale and cross-mode calls, explicit and Laya route conflicts, concurrent duplicate/retry handling, project switching, Stop, connector gating, typed direct routing, live typed-context sync, and production voice dispatch. Run it with `npm test` alongside the existing authority and Task tests.
