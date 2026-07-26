# Full-Screen Realtime Mac Agent — Implementation Architecture

Research snapshot: 2026-07-26

## Direct recommendation

Do **not** build from scratch, and do **not** adopt Hermes, OpenClaw, or Osaurus wholesale.

Build the product as a focused composite:

1. **Fork Samuel (`screen-voice-agent`)** for its Electron/React shell, Rive character, wake word, audio handling, approval UI, and content panels.
2. **Replace Samuel's model and automation layer with a ChatGPT-authenticated Codex app-server.** Codex owns conversation, planning, coding, browser use, macOS control, recovery, and verification.
3. **Adapt the production-hardening patterns from OpenClaw's `extensions/codex` package** for approvals, event projection, health checks, timeouts, session binding, and worker cleanup.
4. **Implement a small local memory service using Osaurus's memory architecture**, plus Hermes's provider boundary and procedural-memory ideas.
5. **Add a controlled Hermes-style learning loop** that turns successful or corrected task trajectories into versioned reusable skills.
6. **Expose Codex-native apps/plugins and MCP servers through a connector hub** for Gmail, Calendar, Drive, Todoist, and future services.
7. Keep Osaurus, Hermes, OpenClaw, and macOS Agent as reference/code donors—not runtime dependencies.

This is the fastest path to a clean final product. Samuel is the closest product shell; OpenClaw has the most mature Codex integration; Osaurus has the best directly relevant memory design.

## ChatGPT subscription constraint

Codex supports **Sign in with ChatGPT** for subscription-backed local usage in the desktop app, CLI, and IDE. Our managed app-server process should reuse that authenticated Codex home/session instead of requiring an API key for execution.

However, a ChatGPT subscription does not generally provide OpenAI Platform API credits. Direct calls from a custom app to the public Realtime or Responses API are billed separately.

The installed Codex app-server has an experimental `thread/realtime/start` protocol with text or audio output, WebRTC support, live transcripts, streamed output audio, and handoffs into Codex turns. We tested it against the user's current **ChatGPT-authenticated** Codex installation:

- WebRTC `v3`: **passed**. Codex returned a real SDP answer; ICE connected; the `oai-events` data channel opened; locally generated speech was transcribed; and the assistant returned a spoken realtime response. No API key was present.
- WebSocket `v2`: **failed** with `insufficient_quota`, proving this transport attempted to use separately billed OpenAI API quota.
- WebRTC `v1`: **failed** with `403 Voice session access denied`.

Therefore the subscription-backed voice path for this installation is specifically:

```text
our WebRTC audio UI
        ↕
ChatGPT-authenticated Codex app-server realtime thread
        ↕
the same Codex thread performs tools and computer tasks
```

This is an under-development Codex feature, is not publicly guaranteed for every ChatGPT plan, and can change between Codex builds. Therefore implement:

```ts
interface VoiceBackend {
  start(threadId: string): Promise<void>;
  appendAudio(chunk: ArrayBuffer): Promise<void>;
  appendText(text: string): Promise<void>;
  stop(): Promise<void>;
}
```

Backends, in priority order:

1. `CodexRealtimeBackend` — first choice; use WebRTC `v3` through the user's ChatGPT-authenticated app-server.
2. `LocalVoiceBackend` — local transcription and TTS, with text sent to subscription-backed Codex.
3. `OpenAIRealtimeApiBackend` — best supported speech-to-speech fallback, but requires separate API billing.

Do not use Codex WebSocket `v2` as a fallback unless separate API billing is explicitly configured. Keep the local backend because the working WebRTC path is experimental.

## What each repository contributes

| Repository | Reuse | Avoid | Verdict |
|---|---|---|---|
| [Samuel / screen-voice-agent](https://github.com/sambuild04/screen-voice-agent) | Electron + React app, OpenAI Realtime session, Rive avatar, wake word/passive listening, state animation, approvals, content panels, macOS bridge | Its 520×740 transparent overlay window, simplistic JSON memory, custom Accessibility/Playwright executor | **Fork this as the product shell** |
| [OpenAI Codex](https://github.com/openai/codex) | Official app-server protocol, persistent threads, turn steering/interruption, approvals, elicitations, MCP/plugin access, coding and Computer Use execution | Forking Codex core; duplicating its planner or computer controller | **Use as a managed execution service** |
| [OpenClaw](https://github.com/openclaw/openclaw) | `extensions/codex`: app-server client, approval/elicitation bridges, event projection, session binding, Computer Use health, timeouts, cleanup | The entire gateway, channel ecosystem, messaging integrations, and multi-user platform | **Adapt the Codex harness, not OpenClaw** |
| [Osaurus](https://github.com/osaurus-ai/osaurus) | Identity + pinned facts + episodes + transcript memory, relevance gate, background distillation, FTS5 fallback, task loop, typed tool envelopes, computer-use feed ideas | Local model runtime, relay/identity network, sandbox platform, plugin marketplace, its own browser/computer agent | **Best memory and safety reference** |
| [Hermes](https://github.com/hermes-agent-org/hermes) | Memory provider boundary, failure-isolated recall, conversation search, skills/procedural memory, isolated delegation | Python runtime, gateway, messaging surfaces, its entire tool ecosystem | **Borrow interfaces and ideas** |
| [macOS Agent](https://github.com/macos26/agent) | Native permission checks, Swift Accessibility patterns, ScreenCaptureKit/AX ideas, reversible file operations | Its model/router stack and separate automation engine | **Reference for Mac-native helpers only** |

Licenses inspected: Samuel, OpenClaw, Osaurus, Hermes, and macOS Agent are MIT; Codex is Apache-2.0. The installed Codex Computer Use/Browser Use components should be invoked in place rather than copied or redistributed.

## Existing-project shortcut

### Closest clean base: Samuel

Samuel already has much of the interaction layer:

- continuous realtime voice;
- an animated Rive character with idle/listening/thinking/speaking states;
- wake-word and passive-listening behavior;
- audio interruption and session rotation;
- tool approval cards;
- an Electron-to-macOS IPC bridge;
- an internal `show_content` panel system.

Its main mismatch is localized: it creates a small transparent `520 × 740` window. Replace that window and the top-level layout with a full-screen, selected-display stage.

Engineering estimate, not a measured percentage:

- Samuel supplies roughly **60–70% of the voice/UI shell**.
- It supplies roughly **35–45% of the complete product**, because Codex supervision, durable memory, full-screen presentation, and the Show Me data plane still need work.

### Fastest throwaway prototype: Samuel + headless OpenClaw

OpenClaw can run Codex through its native app-server harness and already handles many failure cases. Connecting a Samuel-derived UI to headless OpenClaw could prove the full experience quickly.

Do this only if speed matters more than cleanliness for the first prototype. It retains the OpenClaw gateway and configuration platform the final personal app does not need.

### Why Osaurus is not the base

Osaurus is the most complete general Mac agent platform in this set: native Swift, voice, memory, agent loop, computer/browser use, plugins, sandboxing, and local inference. But its value is inseparable from a large platform whose execution engine would be replaced by Codex. Forking it means removing more architecture than we would add.

## Target system

```text
┌──────────────────── Dedicated external display ────────────────────┐
│ Full-screen Character Stage                                        │
│                                                                    │
│  idle/listening/thinking/working/speaking/approval/error           │
│                                                                    │
│  "Show me" → internal work canvas                                  │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ live window preview · task timeline · results · artifacts    │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
              │ voice/events                         ▲
              ▼                                      │
┌──────────────────────── Local Agent Host ──────────────────────────┐
│ Realtime conversation │ Task router │ Memory │ Approval controller │
│ Task/event store      │ Codex adapter             │ Show Me bridge │
│ Connector registry    │ Skill learner/evaluator   │ Scheduler      │
└────────────────────────────────────────────────────────────────────┘
              │ JSON-RPC over stdio/WebSocket
              ▼
┌──────────────────────── Codex app-server ──────────────────────────┐
│ persistent threads · planning · coding · browser · macOS control   │
│ apps/plugins/MCP · verification · steering · realtime · compaction │
└────────────────────────────────────────────────────────────────────┘
              │
              ▼
 Mac apps · browser · terminal · files · Gmail · Calendar · Todoist
```

## Accepted operating model

The architecture above is now constrained by the following product decisions.

### Companion and work

- The **Companion** is the persistent identity; Codex is the replaceable **Primary Engine**.
- Every request that touches an external system is a **Task**. Pure conversation and local recall remain conversation turns.
- A Task is complete only with a verified outcome. Otherwise it is `Needs Decision`, `Blocked`, `Failed`, `Cancelled`, or temporarily `Suspended`.
- Multiple background/read-only tasks may run in parallel. Exactly one Mac-control task has exclusive desktop control.
- BMO supervises delegated workers, receives progress and the final verified result, and is the only persona that speaks to the user.

### Ambient Companion

- Ambient Awareness is event-driven: Calendar, Todoist, Gmail metadata, task/CI status and normal notifications emit signals; no LLM polls continuously.
- Local “Hey BMO” wake-word detection is the default. A visible listening session begins only after that wake activation or push-to-talk.
- Screen Awareness is opt-in and visibly indicated. It excludes password managers, secure input, banking/financial apps, private browsing, and auth/recovery flows by default.
- Attention modes are `Normal`, `Focus`, `Quiet`, and `Away`. Urgent signals may speak according to the current mode; routine signals stay visual or enter a digest.
- A **Standing Directive** is explicit continuing authority for a defined trigger and action. It can create an unattended Directive Task without another per-occurrence prompt, but it never installs capabilities or broadens its own authority.
- Directives are persistent only when the user asks for “always”; one-off directives expire with their real-world context. Learned patterns become proposals, never active directives by themselves.

### Authority and safety

- Read-only work on already connected services is silent. A normal consequential Task gets one task-scoped approval and may continue unattended within that scope.
- Payments, transfers, purchases, account/security changes, and sensitive/public disclosure always need fresh direct confirmation.
- Permanent deletion of files or external-source content is prohibited. The Companion uses Trash/Recoverable Removal. A confirmed **Forget Request** is the narrow exception for deleting the Companion's own local memory.
- Stop/Esc/menu-bar kill cancels the Task, revokes its authority and prevents automatic resume. It does not guess at undoing completed actions.
- An active Mac-control Task is never silently preempted by an urgent signal; BMO notifies the user, who chooses whether to continue or cancel it.
- Coding may inspect, edit and test an isolated local worktree after Task approval. Commit, push, PR creation, publish and deployment need fresh confirmation.

### Memory, privacy and audit

- Gmail, Calendar, Drive, Todoist and similar services remain canonical sources. The Companion retains summaries, references, episodes, procedures and artifact pointers—not a shadow copy by default.
- The Activity Ledger stores Tasks, signals, authority, actions, outcomes and references indefinitely. Raw audio, screenshots and fetched content live in a short Evidence Cache unless explicitly pinned.
- Memory candidates are promoted only when low-sensitivity, high-confidence and corroborated, or explicitly confirmed.
- “Forget this” displays a deletion preview, then removes applicable local summaries, embeddings, references and procedure candidates; the original external source remains unchanged.
- The v1 Companion Store is encrypted and local to one owner/Mac, with only user-controlled encrypted backup/export. Credentials stay in macOS Keychain and never enter model context, ledger content or learned procedures.
- There is no hidden telemetry; any diagnostic export is explicit.

### Token and model routing

```text
Local Gate (near-zero cost)
  schedules · connector events · metadata · SQLite FTS · dedupe · cooldowns
        ↓
Z.ai Utility Model (stateless, minimized packets)
  triage · summaries · memory/procedure candidates · progress compression
        ↓ escalate on uncertainty or consequence
Codex Primary Engine (ChatGPT authenticated)
  voice · reasoning · planning · workers · coding · browser/computer use
  approvals · recovery · final verification
```

- V1 runs no resident local neural model. The Local Gate is deterministic and resource-light.
- Z.ai receives only bounded Utility Packets: no tools, credentials, raw audio/screenshots, Protected Surface content, or durable history.
- Codex is the sole authority for conversation, control, permissions and verification. If Codex Realtime is unavailable, the Companion retains identity through local speech plumbing plus text-based Codex.
- A configurable Compute Budget preserves wake activation and critical signals while batching/defering low-priority work. Battery or thermal pressure triggers Resource-aware Mode.

## Core rule: no task hardcoding

The host never translates a goal into app-specific steps.

For example, it sends:

```json
{
  "goal": "Open Brave and go to example.com",
  "context": {
    "relevantMemory": [],
    "userPreferences": [],
    "workspace": null
  }
}
```

It does **not** encode “press Command-L,” YouTube selectors, TextEdit document rules, coordinates, or recovery recipes.

Codex owns:

1. observing the current computer state;
2. choosing the next action;
3. detecting that an action failed or landed in the wrong place;
4. recovering;
5. verifying the final outcome.

The host owns only generic infrastructure: permissions, task lifetime, event delivery, memory, presentation, cancellation, and safety boundaries.

## Process architecture

### 1. Character Stage

**Stack:** Electron + React + Rive, initially forked from Samuel.

**Visual direction:** use direct Adventure Time/BMO artwork and animation for this private local build. Treat any sharing, redistribution, or public productization as a separate rights-review gate.

**First visual deliverable:** a responsive BMO state machine with `idle`, `listening`, `thinking`, `working`, `speaking`, `approval`, and `error`. Build cinematic/polished animation only after these states drive the real interaction correctly.

Responsibilities:

- identify the configured external display;
- create one frameless full-screen window on that display;
- hide desktop chrome and remain the display's home surface;
- drive character animation from the agent state machine;
- render captions, approval prompts, errors, and the Show Me canvas;
- handle display disconnect/reconnect without losing the task.

Window behavior:

- use Electron `screen.getAllDisplays()` and persist the selected display ID;
- set bounds to that display and enter full screen;
- do not use `alwaysOnTop` globally, because it can cover approval sheets and system dialogs;
- provide an emergency `Esc`/menu-bar escape;
- restore the stage when the display reconnects.

Character inputs:

- `state`: idle, listening, thinking, working, speaking, showing, needsApproval, error;
- `audioLevel`: mouth movement during speech;
- `attentionX/Y`: subtle eye movement toward active content;
- `taskProgress`: optional expression/intensity input;
- `interrupt`: immediate transition back to listening.

Rive is preferable to frame-by-frame video because the state machine, face parts, and lip movement remain independently controllable.

### 2. Realtime Conversation Controller

Keep the voice/personality controller as an app-owned module, while using Codex WebRTC `v3` as its primary session backend.

Responsibilities:

- create a real `RTCPeerConnection`, audio track, and `oai-events` data channel;
- call experimental Codex `thread/realtime/start` with WebRTC `v3`;
- speech detection, interruption, transcription, and spoken response;
- keep the character conversational while a worker task runs;
- let Codex's realtime delegation/handoff protocol invoke Codex turns;
- expose `show_task`, `hide_task`, `cancel_task`, and `answer_approval`;
- receive task events and summarize results naturally.

The Realtime model decides whether a turn is:

- ordinary conversation answered directly;
- a memory lookup;
- a task delegated to Codex;
- a follow-up/steering instruction for an active Codex turn.

There should be no keyword list mapping apps or verbs to workflows.

### 3. Codex Adapter

Run the official Codex binary as a managed child process:

```text
codex app-server --listen stdio://
```

The adapter is a TypeScript service with these modules:

```text
codex/
  ProcessSupervisor.ts
  RpcClient.ts
  ThreadRegistry.ts
  TurnController.ts
  ApprovalBridge.ts
  ElicitationBridge.ts
  EventProjector.ts
  ComputerUseHealth.ts
  CleanupManager.ts
```

Responsibilities:

- initialize app-server capabilities;
- start/resume Codex threads;
- submit natural-language goals;
- steer or interrupt active turns;
- turn raw app-server notifications into stable application events;
- bridge approvals and user-input requests;
- monitor Computer Use availability;
- clean up process groups and orphaned workers;
- restart after crashes without duplicating the task;
- retain Codex thread IDs for later follow-ups.

Use [Codex app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) as the protocol authority. Use [OpenClaw's Codex harness](https://github.com/openclaw/openclaw/blob/main/docs/plugins/codex-harness.md) and its [`extensions/codex`](https://github.com/openclaw/openclaw/tree/main/extensions/codex) source as the reliability reference.

Do not import `@openclaw/codex` directly into the final app initially. Although published as a package, it expects the OpenClaw plugin SDK and host lifecycle. Extract/adapt only the app-server modules we need under the MIT license, preserving notices.

### 4. Task Orchestrator

The orchestrator is deliberately thin:

```ts
interface Task {
  id: string;
  goal: string;
  sourceConversationId: string;
  codexThreadId?: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";
  approvalScopeId?: string;
  createdAt: number;
}
```

It:

- creates a task from a Realtime tool call;
- fetches a bounded memory packet;
- gives the goal and packet to Codex;
- streams projected events to the character;
- stores artifacts and the final verified outcome;
- returns a compact result to the voice controller.

It does not plan the task or choose computer actions.

### 5. Approval Controller

Desired interaction:

> “Allow the agent to control your computer for this task?”

After approval, issue an in-memory capability scoped to:

- one task ID;
- one Codex turn/thread;
- a default two-hour maximum lifetime, with direct approval required to extend;
- the agreed execution scope.

Routine follow-up approval requests within that task can be accepted automatically. The capability expires on completion, cancellation, or timeout. Pending approvals remain visibly paused and receive attention-policy-aware reminders after 2, 5, and 10 minutes, then at a slower cadence, until the person responds or the task expires. After an app quit or process restart, the Companion restores the Task from durable state, re-observes reality, and must revalidate that the original scope and authority remain valid before any further action.

Re-prompt for actions outside the original scope or with irreversible consequences, such as sending a message, purchase, credential change, destructive deletion, or publishing. This is a generic safety boundary, not app-specific task logic.

OpenClaw's approval and elicitation bridges are the best reference here.

### 6. Memory Service

Use local SQLite in WAL mode. Start with FTS5; add embeddings only if measured recall quality requires them.

Schema:

```text
identity
  user-authored overrides + compact derived profile

pinned_facts
  content, salience, confidence, source count, last used

episodes
  session/task summary, decisions, entities, action items, Codex thread ID

transcript_turns
  raw turns for exact or historical recall

procedures
  reusable user preferences and learned workflows

tasks + task_events + artifacts
  durable execution history and Show Me replay
```

Write path:

1. append conversation/task events synchronously;
2. after inactivity or session end, run one background distillation;
3. produce an episode, fact candidates, and possible identity updates;
4. deduplicate and persist;
5. periodically decay, merge, promote, and evict.

Read path:

1. run a cheap relevance gate;
2. choose at most one primary memory section;
3. retrieve a bounded packet—approximately 500–1,000 tokens;
4. include source episode/task IDs;
5. fall back to transcript search for exact wording.

This follows [Osaurus's memory design](https://github.com/osaurus-ai/osaurus/blob/main/docs/MEMORY.md). Hermes's [`MemoryProvider`](https://github.com/hermes-agent-org/hermes/blob/main/agent/memory_provider.py) and memory manager are useful for keeping the store replaceable and ensuring a memory outage never blocks the live conversation.

For “what did we do last week?”, retrieve the episode and linked task. If continuation is useful, resume its stored Codex thread; otherwise provide the compact outcome to a fresh turn.

### 7. Self-improvement loop

Hermes's useful self-improvement mechanism does not change model weights. It turns experience into procedural skills:

```text
task trajectory
      ↓
background reviewer
      ↓
reusable lesson or skill candidate
      ↓
validate + security scan + replay test
      ↓
versioned active skill
      ↓
future Codex turns discover and use it
```

Trigger a background review when:

- a non-trivial task succeeds;
- Codex needed trial and error or changed approach;
- the user corrects the agent;
- an existing skill fails and a better procedure is discovered;
- a workflow repeats enough to be worth formalizing.

The reviewer receives the task goal, projected action/result trajectory, corrections, final verification, and relevant existing skills. It may:

- save a factual lesson to memory;
- create a new procedural skill;
- propose a patch to an existing skill;
- record that nothing reusable was learned.

Use three skill states:

```text
candidate → tested → active
              ↓
           rejected
```

Promotion rules:

1. validate `SKILL.md` structure and size;
2. scan scripts and references for unsafe instructions, credential access, prompt injection, and out-of-scope writes;
3. replay the skill against the saved task or a synthetic fixture;
4. compare the result with the prior successful outcome;
5. store a versioned diff and rollback point;
6. activate only after the checks pass.

Low-risk instruction-only skills may auto-promote after testing. Skills containing executable scripts, new external actions, expanded permissions, or destructive behavior require user approval.

Never allow the learning loop to:

- edit the core application or approval policy;
- grant itself permissions;
- read or store connector credentials;
- turn one accidental success into a permanent procedure;
- bypass Codex's own observation, reasoning, or verification.

Repository layout:

```text
skills/
  candidates/
  active/
    <skill-name>/
      SKILL.md
      references/
      templates/
      scripts/
      evaluations/
      versions/
  rejected/
```

Store performance metadata separately:

```text
skill_runs
  skill_id, version, task_id, selected_at, success,
  user_corrected, retries, latency, failure_reason
```

This lets the agent improve or retire skills based on evidence instead of continuously rewriting them.

### 8. Connector Hub

The assistant should have authorized access to the user's services, but it should not copy “literally everything” into the prompt or long-term memory.

Use **live connectors for source data** and memory only for durable facts, preferences, decisions, and task outcomes.

Preferred connector order:

1. **Codex-native app/plugin** authenticated through the user's ChatGPT account.
2. **Official hosted MCP server** with OAuth.
3. **Local MCP server or direct API adapter** only when no maintained official option exists.
4. **Computer Use** as the final fallback for services without a usable API or connector.

Initial connectors:

| Service | Preferred route | Capabilities |
|---|---|---|
| Gmail | ChatGPT/Codex Google app | Search/read mail, draft and manage mail subject to available actions |
| Google Calendar | ChatGPT/Codex Google app | Read schedule, create/update events with approval |
| Google Drive/Docs | ChatGPT/Codex Google app | Search, read, create/update files subject to scopes |
| Todoist | Official Todoist ChatGPT app or `https://ai.todoist.net/mcp` | Read/create/update/complete tasks and projects |
| GitHub | Codex GitHub app/plugin | Issues, PRs, repositories, reviews |
| Future services | Codex plugin directory or MCP | Capability discovered from the tool manifest |

Codex app-server already exposes app/plugin discovery, installation state, authorization flows, and MCP status/tool calls. The desktop app should project those into a simple **Connections** screen rather than building separate OAuth code for every service.

```text
Connections UI
      ↓
Connector Registry
      ├── Codex apps/plugins
      ├── remote OAuth MCP
      ├── local stdio MCP
      └── Computer Use fallback
```

Each connector record stores only:

```text
id, provider, display name, auth status, scopes,
read/write capability, last health check, last sync cursor
```

Tokens remain in the provider's/Codex's credential store or macOS Keychain. They never enter model context, task events, transcripts, screenshots, or learned skills.

#### Personal context retrieval

Before a turn, the context planner may search connector metadata to decide which source is relevant. Codex then queries that source live.

Examples:

- “What should I focus on today?” → Calendar + Todoist + urgent/recent Gmail.
- “Reply to the email about Friday's meeting.” → Gmail + Calendar, then approval before sending.
- “What did we decide last week?” → local episodes first; Gmail/Calendar/Drive only if required.

Do not maintain one enormous unified copy of every email and document. If optional local indexing is added later, index metadata and user-approved summaries, encrypt it, keep source IDs, support deletion, and fetch the authoritative content live.

#### Proactive context

Use connector events or bounded schedules for:

- upcoming meetings;
- overdue/high-priority Todoist tasks;
- explicitly watched senders or threads;
- task outcomes that require a follow-up.

Proactive rules must be user-created or explicitly confirmed. Connecting Gmail must not automatically turn the assistant into an always-reading notification engine.

### 9. Show Me data plane

Do not try to re-parent arbitrary third-party macOS windows into Electron. That is brittle and conflicts with macOS security/window ownership.

Instead, the Show Me canvas has three generic sources:

1. **Task timeline:** projected Codex status, tool calls, approvals, and verification events.
2. **Live window preview:** ScreenCaptureKit stream of the target app/window, or the screenshots already produced by Computer Use.
3. **Artifacts/results:** Markdown, code diffs, images, web pages, files, tables, and final summaries rendered inside the app.

Behavior:

- default: animated face remains full-screen while Codex works;
- user says “show me”: face transitions into a smaller animated region and the work canvas appears;
- user says “hide it”: canvas disappears without interrupting the task;
- when work completes: canvas can close automatically and the character speaks the result.

For browser-only results, an isolated Electron `WebContentsView` may display a page. It should not replace Codex's browser/control path; it is a presentation surface.

### 10. Event contract

Normalize every subsystem into a small event vocabulary:

```ts
type AgentEvent =
  | { type: "voice.listening" }
  | { type: "voice.speaking"; text?: string }
  | { type: "task.started"; taskId: string; goal: string }
  | { type: "task.progress"; taskId: string; summary: string }
  | { type: "task.preview"; taskId: string; source: PreviewSource }
  | { type: "task.approval"; taskId: string; request: ApprovalRequest }
  | { type: "task.artifact"; taskId: string; artifact: Artifact }
  | { type: "task.completed"; taskId: string; result: TaskResult }
  | { type: "task.failed"; taskId: string; error: PublicError };
```

The character animation, spoken updates, timeline, and memory writer all consume this event stream. They do not parse Codex's raw protocol independently.

### 11. Reliability requirements

These are mandatory because the proof client already exposed stale-session and worker-lifecycle failures:

- start Codex in its own process group;
- kill the entire group on task/app shutdown;
- heartbeat and health-check the app-server connection;
- detect and recover stale Computer Use services;
- enforce separate control-plane, tool-call, and idle-completion timeouts;
- correlate all events by task, thread, turn, and tool-call ID;
- make event handling replay-safe and idempotent;
- persist task state before executing externally visible work;
- expose Stop and Steer from voice at all times;
- after reconnection, query thread state rather than blindly resubmitting.

OpenClaw's Computer Use health, timeout, cleanup, and event-projector modules directly address these concerns.

## Recommended repository layout

```text
bmo-agent/
  apps/
    desktop/                  # Electron main + React renderer
  packages/
    character/                # Rive state machine and visual states
    realtime/                 # Voice session and conversation controller
    orchestrator/             # Tasks, routing, event bus
    codex-adapter/            # App-server client and supervision
    memory/                   # SQLite, FTS5, distillation, retrieval
    learning/                 # Skill review, validation, evals, versions
    connectors/               # Codex app/plugin and MCP registry
    scheduler/                # Explicit proactive watches and reminders
    approvals/                # Task-scoped capabilities and risk boundary
    show-me/                  # Timeline, capture preview, artifact renderers
    shared/                   # Typed events, schemas, logging
  skills/
    candidates/
    active/
    rejected/
  assets/
    character.riv
  vendor-notices/
  tests/
    protocol/
    memory/
    reliability/
    end-to-end/
```

Use one TypeScript monorepo at first. A native Swift helper should be introduced only for capabilities Electron cannot provide cleanly—primarily ScreenCaptureKit window streaming, display control, and Keychain/TCC helpers.

## Build sequence

### First shippable vertical slice

Do not begin with connectors, ambient monitoring, self-improvement, or broad memory. First ship one complete loop: selected-display BMO stage, realtime voice, a general natural-language Codex Task, one task-scoped approval, adaptive visible progress, a Verified Outcome, and a durable Activity Ledger entry. This validates the product's distinctive interaction before capability expansion.

### Milestone 1 — Full-screen character

- fork Samuel;
- replace its overlay window with selected-display full screen;
- implement all animation states;
- add the pluggable `VoiceBackend`;
- integrate the now-proven ChatGPT-authenticated WebRTC `v3` path from `outputs/test-codex-realtime-webrtc.mjs`;
- retain Samuel's direct Realtime transport only as a fallback;
- add a placeholder Show Me transition.

Acceptance: the character lives on the spare display for an hour, handles sleep/display reconnect, listens, interrupts, and speaks without exposing the desktop.

### Milestone 2 — Codex worker

- turn the proven app-server script into `codex-adapter`;
- add thread registry, event projection, steering, interruption, and cleanup;
- replace Samuel's computer-control tools with one generic delegation tool;
- add one task-scoped approval.

Acceptance: arbitrary natural-language Mac/browser/coding goals run without task-specific rules; the character reports progress and completion.

### Milestone 3 — Durable memory

- implement the Osaurus-style schema;
- add background episode distillation;
- add relevance-gated recall and exact transcript search;
- store task outcomes and Codex thread IDs;
- add a simple memory inspector/delete UI.

Acceptance: a request can correctly reference a conversation or completed task from a week earlier without dumping full history into every prompt.

### Milestone 4 — Connectors

- project Codex app/plugin inventory into the Connections UI;
- ship the Personal Planning Pack: authorize Gmail, Google Calendar, and Todoist;
- add health/status and scope display;
- enforce read/write/destructive approval annotations;
- test live multi-source queries without bulk-copying data into memory.

Acceptance: “Plan my day from Calendar, Todoist, and important Gmail” retrieves live authorized data, explains its proposed plan, and asks before making consequential changes.

Drive and GitHub follow as separate capability releases after this planning loop is reliable.

The first opt-in proactive capability is a Morning Briefing Directive that uses this pack at the person's configured morning trigger and gives a concise spoken BMO summary.

### Milestone 5 — Self-improvement

- save successful/corrected task trajectories;
- run the background memory/skill reviewer;
- create versioned skill candidates;
- add structure validation, security scanning, replay evaluation, promotion, and rollback;
- expose a Learned Skills inspector.

Acceptance: after a non-trivial corrected task, the agent produces a reusable skill, proves it against a replay, and applies it successfully to a later similar goal without hardcoded app logic.

### Milestone 6 — Show Me

- add task timeline and artifact renderers;
- add ScreenCaptureKit window preview through a small Swift helper;
- make Show Me a presentation toggle, independent of execution;
- add completion transition back to the character.

Acceptance: during any task, “show me” reveals current work inside the full-screen app and “hide it” returns to the face without affecting the task.

### Milestone 7 — Hardening

- stale-worker recovery, timeout matrix, crash resume, and event replay;
- task audit log and safe approval expiry;
- Keychain secrets;
- automated protocol and end-to-end tests;
- packaging and update strategy.

## What not to build

- another general-purpose agent framework;
- a second computer-use planner;
- app-specific action recipes;
- a bulk plaintext copy of Gmail, Calendar, Drive, and Todoist;
- custom OAuth implementations where a Codex app or official MCP already exists;
- an unconstrained self-modifying loop that edits production code or permissions;
- a vector database before FTS5 is shown insufficient;
- multi-user accounts, messaging channels, relay networking, or a plugin marketplace;
- a native Swift rewrite before the interaction is proven;
- arbitrary macOS window embedding.

## Final decision

**Production direction:** Samuel-derived full-screen app + ChatGPT-authenticated Codex app-server + Osaurus-inspired local memory + Hermes-style controlled skill learning + Codex/MCP personal-data connectors.

**Code to study/adapt first:**

1. [Samuel's realtime voice and Rive character](https://github.com/sambuild04/screen-voice-agent)
2. [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
3. [OpenClaw Codex harness](https://github.com/openclaw/openclaw/tree/main/extensions/codex)
4. [Osaurus memory](https://github.com/osaurus-ai/osaurus/blob/main/docs/MEMORY.md)
5. [Osaurus Computer Use loop](https://github.com/osaurus-ai/osaurus/blob/main/docs/COMPUTER_USE.md)
6. [Hermes memory and delegation](https://github.com/hermes-agent-org/hermes)
7. [Official Todoist MCP/API](https://developer.todoist.com/)

This reuses the difficult infrastructure without inheriting a bloated product architecture.
