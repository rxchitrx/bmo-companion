# Personal BMO Companion — Product Requirements Document

## Problem Statement

Rachit wants a persistent personal AI Companion that occupies an otherwise idle external display as a full-screen animated BMO character—not a desktop overlay or chat window. It should be conversational in realtime, remember the meaningful context of his work and life, proactively help through explicitly authorized automation, and carry out general computer, browser, coding, research, and connected-service work.

The Companion must feel like one continuous personal presence while avoiding the common failures of agent products: brittle app-specific scripts, opaque background work, permanent copies of private services, endless retries, scattered notifications, repeated approval prompts, and unbounded token use. It must use Codex as the high-trust Primary Engine for conversation, reasoning, computer/browser control, coding, approvals, recovery, and verification; it may use Z.ai only for bounded, stateless, low-cost utility transforms.

## Solution

Build a local-first macOS Companion with a full-screen private BMO Stage on a selected external display. The Companion owns the relationship, memory, task supervision, approvals, Activity Ledger, and presentation. Codex is a managed, replaceable Execution Engine that receives general natural-language goals and determines how to observe, act, recover, and verify without hardcoded UI recipes.

The first release is a complete First Vertical Slice: BMO Stage, realtime voice, one general Codex Task, one scoped approval, adaptive progress, Verified Outcome, and durable Activity Ledger entry. Later releases add the Personal Planning Pack (Gmail, Google Calendar, and Todoist), Morning Briefing Directive, durable memory, controlled self-improvement, Show Me, connector discovery, and ambient awareness.

## User Stories

1. As the Companion Owner, I want BMO to occupy my chosen external display full-screen, so that it feels like a dedicated presence rather than a floating desktop widget.
2. As the Companion Owner, I want the laptop desktop to remain usable while BMO owns only the selected Stage, so that the Companion does not take over my active workspace.
3. As the Companion Owner, I want BMO to return to a Compact Presence when the external display disconnects, so that I do not lose access to the Companion.
4. As the Companion Owner, I want BMO to restore the Stage when the display reconnects, so that the experience is continuous.
5. As the Companion Owner, I want direct Adventure Time/BMO Stage Artwork in my private local build, so that the Companion has the visual character I asked for.
6. As the Companion Owner, I want BMO to visibly be idle, listening, thinking, working, speaking, awaiting approval, or in error, so that I understand its state without reading logs.
7. As the Companion Owner, I want to say “Hey BMO” to begin a visibly indicated Listening Session, so that I can speak naturally without a remote always-on microphone stream.
8. As the Companion Owner, I want push-to-talk as a fallback, so that I have reliable voice control in noisy situations.
9. As the Companion Owner, I want BMO to speak concise progress and completion updates, so that I can stay informed without watching its work.
10. As the Companion Owner, I want ordinary conversation and local recall to remain Conversation Turns, so that simple interaction does not become a heavy Task.
11. As the Companion Owner, I want every read, change, or operation on an external system to become a Task, so that work has clear scope, status, evidence, and control.
12. As the Companion Owner, I want arbitrary natural-language computer, browser, coding, and research goals, so that I do not have to encode app-specific scripts.
13. As the Companion Owner, I want Codex to inspect the current state, choose actions, recover from mistakes, and verify outcomes, so that the system remains general rather than hardcoded.
14. As the Companion Owner, I want only a Verified Outcome to mark a Task complete, so that “done” means the requested result actually happened.
15. As the Companion Owner, I want a Task to clearly enter Needs Decision, Blocked, Failed, Cancelled, or Suspended when appropriate, so that uncertainty is never disguised as success.
16. As the Companion Owner, I want to say “show me” during a Task, so that I can inspect its timeline, artifacts, and live work inside the BMO app.
17. As the Companion Owner, I want Show Me to remain read-only while BMO controls a Task, so that simultaneous control cannot cause conflicting input.
18. As the Companion Owner, I want Take Over to stop BMO’s control before I interact directly, so that the handoff is explicit and safe.
19. As the Companion Owner, I want one approval at the start of a scoped consequential Task, so that I do not have to approve every ordinary follow-up tool call.
20. As the Companion Owner, I want approvals to auto-cover only the same Task, scope, and lifetime, so that one approval never becomes blanket authority.
21. As the Companion Owner, I want Task Approval to last through verified completion but default to a two-hour maximum, so that long-running authority is bounded.
22. As the Companion Owner, I want BMO to ask before extending an approval window, so that I remain in control of unusually long work.
23. As the Companion Owner, I want reminders at 2, 5, and 10 minutes when a Task awaits approval or a decision, so that paused work does not silently disappear.
24. As the Companion Owner, I want reminders to slow down after that and respect my Attention Policy, so that BMO does not become disruptive.
25. As the Companion Owner, I want live commands to outrank all background work, so that I can immediately redirect BMO.
26. As the Companion Owner, I want urgent safety or deadline signals to outrank routine background work, so that important events are not lost.
27. As the Companion Owner, I want an urgent signal to notify me without silently taking over an active Mac-control Task, so that I choose whether to interrupt current work.
28. As the Companion Owner, I want exactly one Mac-control Task at a time, so that desktop actions cannot collide.
29. As the Companion Owner, I want independent read-only and background Tasks to run in parallel, so that BMO can remain productive without desktop contention.
30. As the Companion Owner, I want BMO to supervise all Task Workers and give the final update, so that delegation never fragments the relationship.
31. As the Companion Owner, I want adaptive progress check-ins for long quiet work, so that BMO can investigate without expensive constant polling.
32. As the Companion Owner, I want a short Completion Brief by default and detailed evidence in Show Me or the Activity Ledger, so that I get the right amount of detail.
33. As the Companion Owner, I want Stop/Esc/menu-bar cancellation to immediately revoke remaining authority, so that I can halt work quickly.
34. As the Companion Owner, I want cancellation not to pretend it can undo completed actions, so that task history remains truthful.
35. As the Companion Owner, I want BMO to restore an interrupted Task after an app or Mac restart only by first observing current reality and revalidating authority, so that no browser or desktop action is blindly replayed.
36. As the Companion Owner, I want BMO to use a bounded Recovery Budget before asking me for help, so that it can solve ordinary problems without getting stuck in loops.
37. As the Companion Owner, I want repeated failed Directive Tasks to pause their Standing Directive and surface evidence, so that proactive automation cannot retry forever.
38. As the Companion Owner, I want my Gmail, Calendar, Drive, Todoist, GitHub, and similar services to remain their own External Sources, so that BMO does not become a fragile shadow copy of my life.
39. As the Companion Owner, I want BMO to retain meaningful summaries, references, episodes, procedures, and Artifact References, so that it has continuity without mirroring raw service content.
40. As the Companion Owner, I want memories to distinguish sensory, working, episodic, semantic, procedural, and artifact context, so that recalled information remains useful and appropriately scoped.
41. As the Companion Owner, I want only low-sensitivity, high-confidence, corroborated facts to auto-promote to Active Memory, so that BMO does not confidently invent personal facts.
42. As the Companion Owner, I want sensitive or uncertain facts and learned workflows to remain candidates until reviewed, so that memory remains trustworthy.
43. As the Companion Owner, I want BMO to learn reusable Procedures from successful or corrected work, so that it improves over time.
44. As the Companion Owner, I want Procedures to guide planning, evidence gathering, and verification but never dictate fixed UI coordinates, shortcuts, or scripts, so that Codex still reasons from the current state.
45. As the Companion Owner, I want learned Procedures never to expand permissions, tools, capabilities, or safety boundaries, so that learning cannot become self-authorization.
46. As the Companion Owner, I want self-improvement to create tested Companion Update Proposals rather than self-installing code, so that I approve changes to the system carrying my authority.
47. As the Companion Owner, I want raw screen frames and microphone audio discarded after processing, so that BMO is not a permanent sensory archive.
48. As the Companion Owner, I want fetched raw service content discarded after a Verified Outcome or within 24 hours of unresolved work, so that evidence stays short-lived.
49. As the Companion Owner, I want the Activity Ledger to retain durable summaries, authority, actions, outcomes, and references, so that I can audit what BMO did.
50. As the Companion Owner, I want to pin an Artifact when I explicitly want to preserve it, so that important evidence is retained intentionally.
51. As the Companion Owner, I want to issue a Forget Request and receive a Deletion Preview before confirming it, so that I know exactly which local Companion knowledge will be removed.
52. As the Companion Owner, I want a Forget Request to leave Gmail, Calendar, Drive, and other External Sources unchanged, so that forgetting local context does not destroy source data.
53. As the Companion Owner, I want permanent deletion of files and External Source content prohibited, so that BMO always uses Recoverable Removal such as Trash.
54. As the Companion Owner, I want payments, transfers, purchases, account/security changes, and sensitive/public disclosures to require fresh direct confirmation, so that high-consequence actions never ride on standing authority.
55. As the Companion Owner, I want coding Tasks to use an Isolated Workspace when possible, so that BMO does not disturb my dirty active worktree.
56. As the Companion Owner, I want commit, push, pull-request creation, publishing, and deployment to require fresh confirmation, so that local coding capability does not automatically publish work.
57. As the Companion Owner, I want Ambient Awareness to be event-driven rather than powered by continuous model polling, so that BMO remains affordable and resource-aware.
58. As the Companion Owner, I want enabled Calendar, Todoist, Gmail metadata, task status, and system notifications to create Signals, so that BMO can be proactively useful.
59. As the Companion Owner, I want sensitive surfaces such as screen OCR, clipboard, full mail/document indexing, and ambient microphone recording to require explicit opt-in, so that private observation is deliberate.
60. As the Companion Owner, I want protected surfaces—password managers, secure input, banking, private browsing, and authentication/recovery—to be excluded by default, so that BMO does not inspect the most sensitive content.
61. As the Companion Owner, I want Standing Directives to contain explicit triggers and authority, so that BMO can proactively notify, prepare, or act only within permission I intentionally gave.
62. As the Companion Owner, I want learned behavior to become only a Directive Proposal until I activate it, so that BMO never turns an observed habit into autonomous authority.
63. As the Companion Owner, I want Persistent Directives to last until I change them and Context-bound Directives to expire with their real-world context, so that authority does not go stale.
64. As the Companion Owner, I want Normal, Focus, Quiet, and Away Attention Modes, so that proactive behavior follows my current situation.
65. As the Companion Owner, I want BMO to suggest but never silently change my Attention Mode, so that I control how it interrupts me.
66. As the Companion Owner, I want approved unattended connector work to continue while I am away, so that routine work does not require me to sit at the Mac.
67. As the Companion Owner, I want Mac-control work to suspend while macOS is locked or unavailable and resume only when the surface returns with valid scope, so that desktop control remains safe.
68. As the Companion Owner, I want a configurable Compute Budget and Resource-aware Mode, so that BMO preserves wake activation and critical signals while throttling non-urgent work under battery, thermal, or budget pressure.
69. As the Companion Owner, I want a non-neural Local Gate to handle schedules, metadata, deduplication, cooldowns, and routing, so that BMO does not need a resident local LLM.
70. As the Companion Owner, I want Codex to handle conversation, consequential reasoning, coding, browser/computer control, approvals, recovery, and final verification, so that the strongest engine owns high-trust work.
71. As the Companion Owner, I want Z.ai to handle only stateless, minimized utility transforms such as triage, summaries, candidate extraction, and progress compression, so that my available credits reduce cost without weakening control.
72. As the Companion Owner, I want Utility Packets to exclude credentials, raw audio, raw screenshots, protected-surface content, and unbounded history, so that the utility path does not become a private-data export channel.
73. As the Companion Owner, I want each Capability Connection to show scopes, reads/writes, connection time, last use, and revoke control, so that I can understand connected-service authority.
74. As the Companion Owner, I want connector loss or scope reduction to suspend only dependent Tasks and Directives, so that one broken connection does not disable BMO.
75. As the Companion Owner, I want BMO to continuously discover and vet useful connectors based on repeated friction, so that it can suggest missing capabilities without silently installing them.
76. As the Companion Owner, I want new connector installation, OAuth connection, or scope changes to require direct approval, so that capability discovery cannot create authority.
77. As the Companion Owner, I want blocked or repeatedly painful work to surface connector recommendations immediately and other findings to enter a digest, so that recommendations are timely without becoming noise.
78. As the Companion Owner, I want the first connector release to be the Personal Planning Pack—Gmail, Google Calendar, and Todoist—so that BMO can solve a coherent daily planning problem.
79. As the Companion Owner, I want an opt-in Morning Briefing Directive to summarize Calendar, Todoist priorities, and important Gmail at a configured morning trigger, so that BMO becomes useful before I ask.
80. As the Companion Owner, I want the Companion Store encrypted and local to one owner/Mac with only user-controlled encrypted backup/export, so that my personal data is not silently synced to a cloud service.
81. As the Companion Owner, I want connector secrets to live only in macOS Keychain, so that credentials never appear in memory, procedures, logs, screenshots, or Utility Packets.
82. As the Companion Owner, I want no hidden telemetry and only explicit Diagnostic Exports, so that BMO remains private by default.

## Implementation Decisions

### Product and runtime boundary

- The Companion is the persistent persona, memory owner, and user-facing supervisor. Codex is the Primary Engine and is replaceable at the adapter boundary.
- The product is a selected-display, full-screen Electron/React Stage derived from Samuel’s product-shell patterns. It is not an overlay.
- The private Stage uses direct Adventure Time/BMO Stage Artwork. Distribution, public sharing, or productization is explicitly outside the present authorization and requires a separate rights review.
- The initial Stage State Machine exposes: `idle`, `listening`, `thinking`, `working`, `speaking`, `approval`, and `error`. Cinematic animation comes later.
- Local “Hey BMO” activation and push-to-talk begin a visibly indicated Listening Session. The preferred voice backend is the tested ChatGPT-authenticated Codex WebRTC v3 route; local STT/TTS plus text Codex is the degraded fallback.

### Deep modules

- **Stage Controller:** owns selected-display lifecycle, Stage State Machine, captions, approval presentation, Compact Presence fallback, and Show Me transitions. It accepts stable typed presentation events rather than Codex protocol payloads.
- **Realtime Conversation Controller:** owns Listening Sessions, interruption, transcript/audio lifecycle, voice transport selection, and conversion between conversational intent and Companion actions.
- **Task Orchestrator:** owns Task creation, parent/worker relationships, Work Priority, single Mac-control lease, cancellation, task state transitions, Restart Recovery, Recovery Budget, and durable event emission.
- **Codex Adapter and Process Supervisor:** owns the managed app-server process, threads, turns, steering, approval/elicitation bridge, projected event stream, health checks, timeouts, stale-worker cleanup, and crash recovery. It invokes installed Codex components in place rather than extracting private plugins.
- **Approval and Authority Service:** owns Task Approval scope, two-hour maximum, extension flow, reserved/prohibited action boundaries, Approval Reminders, and revocation on cancellation.
- **Companion Store and Memory Service:** owns encrypted local schema, Activity Ledger, Evidence Cache, sensory/working/episodic/semantic/procedural/artifact records, candidate promotion, Forget Request preview and deletion, and user-controlled backup/export.
- **Procedure Learning Service:** owns trajectory review, candidate generation, evaluation, versioning, rollback, and activation. Procedures are guidance only and cannot expand authority. Self-code changes remain Companion Update Proposals.
- **Ambient Scheduler and Local Gate:** owns deterministic signal intake, deduplication, cooldowns, schedules, Attention Modes, Standing Directives, Directive Suspension, Compute Budget, and Resource-aware Mode. It has no resident neural model.
- **Utility Router:** creates minimized Stateless Utility Calls to Z.ai for bounded transforms and escalates uncertainty or consequence to Codex. It has no direct tools, credentials, browser, Mac, file, or connector access.
- **Connector and Capability Hub:** owns Codex app/plugin/MCP inventory projection, capability vetting, connection scopes/status, Credential Store references, degradation handling, recommendations, and the Personal Planning Pack.
- **Show Me Data Plane:** presents a stable Task timeline, live permitted window preview, artifacts, and final result. It is presentation-only until the person selects Take Over.

### Task and authority model

- A Task is created for every operation on an external system. Conversation Turns are limited to ordinary conversation and local recall.
- Only a Verified Outcome completes a Task. Other states remain explicit and durable.
- Work Priority is fixed: live person command, urgent safety/deadline Signal, active Task, then ordinary Standing Directive work. Lower-priority work queues.
- Multiple Background Tasks can run concurrently; exactly one Task Worker holds the Mac-control lease.
- BMO supervises workers. Workers emit start, milestone, error, Needs Decision, and completion events; BMO gives the sole final Completion Brief.
- Show Me is read-only. Take Over ends BMO’s control of the affected Task before direct interaction.
- Approval is one scoped authority per Task, valid until Verified Outcome with a default two-hour maximum. Routine follow-ups inside that unchanged scope may be automatically accepted. Reserved Actions always need fresh confirmation. Prohibited Actions cannot be approved.
- A Task awaiting approval or Needs Decision is paused and reminded at 2, 5, and 10 minutes, then on a slower Attention-Policy-aware cadence. It can be approved, denied, cancelled, or allowed to expire.
- Restart Recovery restores durable Task context, observes actual current state, revalidates authority/scope, and never blindly replays a prior desktop action.

### Memory, privacy, and audit

- Gmail, Calendar, Drive, Todoist, GitHub, and other connected systems are External Sources and remain canonical. The Companion stores references and learned context, not a default raw mirror.
- The Companion Store is encrypted local storage for one owner/Mac. Credentials reside only in macOS Keychain. Backups and diagnostic exports are user initiated.
- The Activity Ledger retains durable signal, directive, authority, action, outcome, and reference records. Raw material uses the Evidence Cache.
- Evidence Retention Policy: discard raw microphone audio and screen frames after processing; discard fetched raw source content after Verified Outcome or within 24 hours if unresolved. Explicitly pinned material is retained as a Pinned Artifact.
- Memory promotion requires low sensitivity, high confidence, and corroboration or direct confirmation. Sensitive/uncertain data remains a Memory Candidate.
- Forget Request presents a Deletion Preview and then deletes only local Companion Records, embeddings, references, and procedure candidates; it does not touch source content. The Ledger keeps only a content-free deletion audit.
- Screen Awareness is explicit and visible. Password managers, secure-input fields, banking/financial applications, private browsing, and auth/recovery flows are Protected Surfaces by default.

### Proactivity and connectors

- Ambient Awareness is event-driven. Default sources after connection are Calendar, Todoist, Gmail metadata/high-priority signals, task/CI status, and normal system notifications. Screen OCR, clipboard, full content indexing, and ambient microphone recording require explicit opt-in.
- A Standing Directive contains an explicit trigger, authority, response, and lifetime. It may notify, prepare work, or carry out defined Delegated Actions. Learned patterns create Directive Proposals only.
- Directive Tasks can operate unattended within Standing Directive scope. Repeated failures/blocks cause Directive Suspension after a bounded threshold, preserving evidence and requiring the owner to resume, edit, or disable the directive.
- Attention Modes are Normal, Focus, Quiet, and Away. The Companion may suggest a change but not switch mode silently. Urgent signals may speak, but cannot silently preempt Mac control.
- Capability Discovery may inspect task friction and public catalogs. Capability Vetting assesses provenance, scopes, maintenance, license, and risk. It cannot install, connect, or expand scope without direct approval.
- Capability Degradation suspends only dependent Tasks and Directives until the owner reconnects or reauthorizes the capability.
- The first connector release is the Personal Planning Pack: Gmail, Google Calendar, and Todoist. Read-only work is available after connection; writes require Task-scoped approval.
- The first opt-in proactive workflow is the Morning Briefing Directive, which produces a concise spoken daily briefing from the Personal Planning Pack.

### Model routing and efficiency

- Codex is authoritative for realtime conversation, consequential reasoning, planning, Computer Use, browser work, coding, permissions, recovery, worker disagreement resolution, and final verification.
- Z.ai is a Utility Model for high-volume bounded transforms: notification triage, summary drafting, memory/procedure candidate extraction, artifact metadata, and progress compression.
- The routing rule is deterministic: Local Gate for filters/schedules/deduplication, Z.ai for bounded utility transforms, Codex for reasoning/action/verification. Uncertain or consequential utility output escalates to Codex.
- Utility Packets are purpose-bound and exclude credentials, protected surfaces, raw audio/screenshots, and unbounded history. Utility calls are stateless and have no direct system access.
- Compute Budget and Resource-aware Mode preserve wake activation and critical reminders while deferring or throttling nonurgent workers, discovery, and consolidation.

### Safety constraints

- Permanent deletion of local files or External Source content is prohibited. Recoverable Removal is the only cleanup path. Forget Request is the narrow exception for Companion-owned local memory.
- Payments, transfers, purchases, account/security changes, sensitive/public disclosures, commit, push, pull-request creation, publishing, and deployment are Reserved Actions that require fresh direct confirmation.
- Code Tasks use an Isolated Workspace by default. A dirty or non-isolatable workspace creates Needs Decision before modification.
- Personal Accounts remain the identity under which delegated actions occur; BMO has no separate autonomous account.

## Testing Decisions

- Test externally observable behavior and durable state transitions, not implementation details or private Codex prompt wording.
- The Stage Controller should have integration tests for selected-display ownership, Compact Presence fallback, state transitions, visible Listening Session, Show Me/read-only behavior, and Take Over handoff.
- The Task Orchestrator should have deterministic tests for state transitions, Work Priority, single Mac-control lease, cancellation, Recovery Budget exhaustion, Restart Recovery, and idempotent event replay.
- The Approval and Authority Service should have property-style and scenario tests for scope narrowing, two-hour expiration, extension, Approval Reminder cadence, Reserved Actions, Prohibited Actions, and revocation.
- The Codex Adapter should use contract tests against recorded app-server protocol fixtures for thread/turn lifecycle, approvals, elicitations, steering, health failures, stale worker cleanup, and projected events. Use OpenClaw’s Codex harness tests as reliability prior art.
- The Companion Store and Memory Service should test promotion gates, source references, evidence expiry, Pinned Artifacts, Forget Request preview/deletion, ledger content-free forget audit, encrypted backup boundaries, and local-only invariants. Use Osaurus memory and evaluation patterns as prior art.
- The Procedure Learning Service should test candidate → review → evaluation → version → activate/rollback, and prove that learned Procedures cannot introduce permissions, hardcoded UI scripts, new connectors, or self-installed changes. Use Hermes skill-improvement tests as prior art.
- The Ambient Scheduler should test Signals, directives, Attention Modes, deduplication/cooldowns, Directive Suspension, Priority ordering, compute-budget deferral, and Resource-aware Mode.
- The Utility Router should test that Utility Packets are minimized, stateless, tool-free, and escalated when uncertain or consequential.
- The Connector Hub should use mocked official MCP/app manifests and OAuth-degradation scenarios to test scopes, direct connection approval, capability vetting, narrow degradation, revocation, and Personal Planning Pack read/write boundaries.
- End-to-end tests should exercise: “Hey BMO” activation, a generic Codex browser or Mac task, one scoped approval, visible progress, Verified Outcome, and an Activity Ledger record. Later scenarios should exercise planning pack queries, a Morning Briefing Directive, suspension/reconnect, and an urgent signal during a Mac-control Task.

## Out of Scope

- Public release, monetization, App Store distribution, or any distribution rights clearance for BMO artwork.
- Multi-user accounts, shared memories, teams, relay networking, messaging-channel platforms, or a plugin marketplace.
- Forking Codex core, extracting/repackaging Codex’s bundled computer/browser components, or building a replacement computer-use planner.
- A resident local language model or default continuous neural polling.
- Bulk plaintext or permanent mirroring of Gmail, Calendar, Drive, Todoist, browser history, screenshots, or microphone data.
- Automatic connector installation, OAuth authorization, scope expansion, or self-granted permissions.
- Permanent deletion of files or External Source content.
- Automatic code installation, restart, deployment, publishing, committing, pushing, or pull-request creation.
- A native Swift rewrite before the Electron-derived interaction model is proven.
- Arbitrary macOS window embedding in the first release.

## Further Notes

- Reuse strategy: fork Samuel for the Electron/React/Rive shell and audio/approval/panel patterns; use Codex app-server as a managed execution service; adapt OpenClaw’s Codex harness reliability patterns; implement Osaurus-style local memory; adapt Hermes procedural-learning lifecycle; use Codex apps/plugins and official MCP for connectors; use macOS Agent only as a reference for small native Keychain/TCC/ScreenCaptureKit helpers.
- The confirmed first release order is: First Vertical Slice → Personal Planning Pack → Morning Briefing Directive → broader durable memory, self-improvement, Show Me polish, additional connectors, and ambient capability discovery.
- The architecture diagram and source map are maintained alongside this PRD and should be updated whenever a decision changes the component boundary or source-of-truth relationship.
- The workspace currently has no Git remote or configured issue tracker. This PRD is ready to publish with the `ready-for-agent` label once a target repository/tracker is provided.
