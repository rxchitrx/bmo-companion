# Personal Companion

This context defines the language for a persistent personal companion that converses with one person and carries out work on their behalf.

## Language

**Companion**:
The persistent personal identity that converses with the person, remembers their history, and accepts their requests.
_Avoid_: Agent, chatbot, Codex

**Execution Engine**:
A replaceable capability used by the **Companion** to reason about and carry out requested work.
_Avoid_: Companion, personality

**Conversation Turn**:
A request or response handled within the relationship with the **Companion** without operating an external system.
_Avoid_: Task

**Task**:
A bounded unit of requested external work that has a lifecycle, result, cancellation path, and history.
_Avoid_: Conversation Turn, job

**Connected Service**:
An external service the person has already authorized the **Companion** to access.
_Avoid_: Available service, logged-in website

**Task Approval**:
The person's permission for a **Task** to perform a consequential category of external work until its Verified Outcome, with a default two-hour maximum that requires an explicit extension.
_Avoid_: Permanent permission, blanket approval

**Approval Reminder**:
A visible and attention-policy-aware reminder for a Task awaiting a decision, issued after 2, 5, and 10 minutes, then at a slower cadence until the person responds, the Task is cancelled, or its approval window expires.
_Avoid_: New approval request, repeated interruption

**Verified Outcome**:
Evidence that the requested condition for a **Task** has actually been satisfied.
_Avoid_: Attempted action, plausible result

**Needs Decision**:
A **Task** state in which the **Companion** requires the person's choice or missing information to continue.
_Avoid_: Failed

**Blocked**:
A **Task** state in which progress requires unavailable access, capability, or an external change.
_Avoid_: Failed

**Failed**:
A terminal **Task** state in which an attempted outcome could not be achieved.
_Avoid_: Blocked, Needs Decision

**Show Me**:
The Companion's read-only presentation of a **Task**'s live progress, artifacts, or result.
_Avoid_: Remote desktop, control surface

**Take Over**:
The person's explicit transition from Companion-controlled work to direct personal control of the underlying external system.
_Avoid_: Shared control

**Mac-control Task**:
A **Task** that operates the person's Mac desktop, application windows, browser, files, or terminal.
_Avoid_: Background Task

**Background Task**:
A **Task** that does not operate the person's Mac desktop and may run alongside other compatible work.
_Avoid_: Mac-control Task

**External Source**:
An external system that remains the canonical owner of its content and current state.
_Avoid_: Companion memory, local copy

**Memory Record**:
Durable context the **Companion** retains about the person, a **Task**, or an **External Source**.
_Avoid_: Source of truth

**Artifact Reference**:
A **Memory Record** that identifies an externally owned file, message, event, or result without becoming its canonical copy.
_Avoid_: Artifact copy

**Memory Candidate**:
A proposed **Memory Record** that has not yet met the Companion's rule for durable use.
_Avoid_: Active memory, fact

**Active Memory**:
A **Memory Record** the Companion may use in future conversations or Tasks.
_Avoid_: Memory Candidate

**Procedure**:
A reusable, verified way the Companion has learned to carry out a recurring kind of Task.
_Avoid_: Permission, policy

**Safety Boundary**:
A rule that a Procedure or Execution Engine cannot alter without the person's explicit approval.
_Avoid_: Learned preference

**Personal Account**:
An external account owned by the person through which the Companion performs authorized work.
_Avoid_: Agent account, bot identity

**Delegated Action**:
An external action the Companion performs through a Personal Account on the person's behalf.
_Avoid_: Independent agent action

**Unattended Task**:
A Task with an approval that permits the Companion to continue authorized Delegated Actions while the person is not actively present.
_Avoid_: Unapproved background action

**Suspended Task**:
A Task temporarily unable to progress because the required execution surface is unavailable while its valid authority remains intact.
_Avoid_: Blocked, Failed

**Cancellation**:
The person's immediate termination of a Task and revocation of its remaining authority.
_Avoid_: Take Over, undo

**Ambient Awareness**:
The Companion's continuous, event-driven observation of enabled sources and local signals without requiring a direct prompt.
_Avoid_: Constant model polling, Task

**Signal**:
A detected change or condition that Ambient Awareness may evaluate for relevance to the person.
_Avoid_: Task, memory

**Standing Directive**:
The person's continuing pre-authorization for the Companion to respond to a defined class of Signals in a defined way.
_Avoid_: Procedure, inferred permission

**Directive Task**:
A Task created by a matching Signal under a Standing Directive rather than a fresh direct prompt.
_Avoid_: Unapproved task

**Directive Proposal**:
A suggested Standing Directive inferred from repeated behavior that has no authority until the person activates it.
_Avoid_: Standing Directive, permission

**Directive Authority**:
The continuing Task Approval granted by an active Standing Directive for its explicitly named Delegated Actions.
_Avoid_: Blanket permission

**Directive Suspension**:
The automatic pause of a Standing Directive after its bounded consecutive failures or blocks, preserving its evidence and requiring the person to decide whether to resume, edit, or disable it.
_Avoid_: Endless retry, Cancellation

**Persistent Directive**:
A Standing Directive that remains active until the person pauses or disables it.
_Avoid_: Context-bound Directive

**Context-bound Directive**:
A Standing Directive whose authority ends when its associated real-world context ends.
_Avoid_: Persistent Directive

**Activity Ledger**:
The durable record of Signals, Tasks, Directives, approvals, actions and outcomes visible to the person.
_Avoid_: Hidden telemetry

**Evidence Cache**:
Short-lived raw material retained only to support an active Task, verification, or immediate inspection.
_Avoid_: Activity Ledger, permanent archive

**Evidence Retention Policy**:
The default expiry rule for raw material: microphone audio and screen frames are discarded after processing; fetched source content is discarded after Verified Outcome, or within 24 hours when the Task remains unresolved.
_Avoid_: Activity Ledger retention, Pinned Artifact

**Pinned Artifact**:
An Artifact Reference or result the person explicitly chooses to retain beyond ordinary Evidence Cache expiry.
_Avoid_: Evidence Cache

**Companion Owner**:
The single person whose identity, memory, Personal Accounts and authority define a Companion instance.
_Avoid_: Team member, shared user

**Stage**:
The Companion's dedicated full-screen display surface for its character, Show Me and approval experience.
_Avoid_: Desktop overlay

**Compact Presence**:
The Companion's reduced menu-bar and voice interface used when the Stage is unavailable.
_Avoid_: Laptop takeover

**Recovery Budget**:
The bounded independent effort a Task may spend observing, retrying and trying alternatives before requiring the person.
_Avoid_: Endless retry

**Restart Recovery**:
The restoration of an interrupted Task from its Activity Ledger state after the Companion or Mac restarts; it must inspect the current external state and revalidate authority before any further action, never replay past desktop actions blindly.
_Avoid_: Action replay, automatic completion

**First Vertical Slice**:
The first shippable end-to-end build: full-screen BMO, realtime voice, a general Codex Task, one scoped approval, visible progress, Verified Outcome, and Activity Ledger, before connectors or ambient automation.
_Avoid_: Feature-only prototype, connector-first build

**Stage Artwork**:
The direct Adventure Time/BMO visual artwork and animation used on the Companion's private local Stage; any sharing, distribution, or public productization requires a separate rights review.
_Avoid_: Original replacement character, distribution clearance

**Stage State Machine**:
The small responsive visual system for Stage Artwork: idle, listening, thinking, working, speaking, approval, and error; a richer cinematic animation layer follows after the core interaction works.
_Avoid_: Static wallpaper, full animation production

**Reserved Action**:
A high-consequence Delegated Action that always requires fresh direct confirmation and cannot be authorized solely by a Standing Directive.
_Avoid_: Directive Authority

**Prohibited Action**:
An action the Companion may not perform under any approval or Standing Directive.
_Avoid_: Reserved Action

**Forget Request**:
The person's request to remove a target from the Companion's local retained knowledge.
_Avoid_: Deleting the External Source

**Deletion Preview**:
The final content summary of local records a Forget Request would remove before the person confirms deletion.
_Avoid_: Immediate deletion

**Companion Store**:
The encrypted local storage containing the Companion's retained local data for its Companion Owner.
_Avoid_: External Source

**Companion Backup**:
A user-controlled encrypted export of the Companion Store used for recovery.
_Avoid_: Automatic cloud sync

**Offline Mode**:
A Degraded Conversation state in which the Companion has local capabilities but cannot reach required external services or an Execution Engine.
_Avoid_: Different Companion

**Service-dependent Task**:
A Task that requires a currently unavailable external service or Execution Engine to progress.
_Avoid_: Failed Task

**Screen Awareness**:
The person's explicitly enabled Ambient Awareness of the active laptop display, indicated while it is active.
_Avoid_: Hidden screen capture

**Protected Surface**:
A sensitive screen context that Screen Awareness automatically excludes unless the person explicitly overrides the exclusion for a specific case.
_Avoid_: Default screen context

**Task Worker**:
An internal Execution Engine instance assigned a bounded part of a Task.
_Avoid_: Companion

**Delegated Subtask**:
A bounded part of a Task assigned to a Task Worker and tracked under the parent Task.
_Avoid_: Independent task

**Task Supervision**:
The Companion's ongoing ability to inspect, steer, cancel and summarize the work of Task Workers.
_Avoid_: Detached frontend

**Progress Event**:
A meaningful reported state change in a Task or Delegated Subtask.
_Avoid_: Constant status poll

**Progress Check-in**:
An adaptive lightweight inspection by Task Supervision when long-running work has not emitted a Progress Event.
_Avoid_: Continuous reasoning loop

**Completion Brief**:
The Companion's concise spoken report of a Task's verified outcome or the reason it requires the person.
_Avoid_: Full task transcript

**Compute Budget**:
The configurable limit on Companion reasoning and worker compute over a defined period.
_Avoid_: Unlimited background spend

**Token Economy**:
The Companion's deliberate use of cheap local filtering and bounded context before invoking expensive Execution Engine reasoning.
_Avoid_: Constant full-model polling

**Local Gate**:
The low-overhead local rules, schedules, metadata checks and text search that filter Signals before Execution Engine reasoning.
_Avoid_: Resident local AI model

**Resource-aware Mode**:
The Companion's reduced-compute behavior during battery, low-power or thermal pressure.
_Avoid_: Unbounded background work

**Primary Engine**:
The high-trust Execution Engine used for the Companion's conversation, consequential reasoning, coding, computer control and final verification.
_Avoid_: Utility Model

**Utility Model**:
A lower-cost external model used for bounded, non-authoritative transformations such as summarization, classification and candidate generation.
_Avoid_: Primary Engine, authority owner

**Utility Packet**:
The minimized, purpose-bound context the Companion sends to a Utility Model for one bounded transformation.
_Avoid_: Full personal archive

**Stateless Utility Call**:
A Utility Model request with no retained conversation, profile, long-term memory or task history at the Utility Model.
_Avoid_: Secondary Companion memory

**Routing Policy**:
The deterministic rule that assigns work to the Local Gate, Utility Model or Primary Engine according to capability and consequence.
_Avoid_: Model-selected authority

**Escalation**:
The Routing Policy's transfer of uncertain or consequential work from a lower-cost layer to the Primary Engine.
_Avoid_: Silent low-trust decision

**Worker Disagreement**:
Conflicting findings from Task Workers about the same Task.
_Avoid_: Person preference

**Companion Update Proposal**:
A tested proposed change to the Companion's own code or configuration that has no effect until the person approves it.
_Avoid_: Self-installed update

**Capability Connection**:
The person's direct authorization of a new external service, plugin or permission scope for the Companion.
_Avoid_: Standing Directive

**Capability Degradation**:
The loss, expiry, revocation, or scope reduction of a Capability Connection that suspends only the Tasks and Standing Directives depending on it until the person reconnects or reauthorizes it.
_Avoid_: Global outage, Task failure

**Personal Planning Pack**:
The first connector release: Gmail, Google Calendar, and Todoist working together on live planning and reminders, with read-only access by default and Task-scoped approval for writes.
_Avoid_: Bulk service mirror, unrestricted automation

**Morning Briefing Directive**:
The first opt-in Standing Directive: at its configured morning trigger, BMO reads live Calendar, Todoist priorities, and important Gmail through the Personal Planning Pack and gives a concise spoken Stage briefing.
_Avoid_: Default always-on inbox reading, unconstrained automation

**Capability Discovery**:
The Companion's ongoing search for potentially useful connectors or plugins based on Task patterns, friction and public capability catalogs.
_Avoid_: Automatic installation

**Capability Recommendation**:
A suggested connector or plugin produced by Capability Discovery that has no authority until the person approves a Capability Connection.
_Avoid_: Installed capability

**Capability Digest**:
A quiet periodic summary of non-urgent Capability Recommendations.
_Avoid_: Interruptive recommendation

**Capability Vetting**:
The Companion's evaluation of a potential connector or plugin's provenance, requested authority, maintenance, license and risk before recommendation.
_Avoid_: Automatic trust

**Diagnostic Export**:
A person-initiated bundle of selected local diagnostic information for troubleshooting or feedback.
_Avoid_: Hidden telemetry

**Credential Store**:
The operating-system protected storage for connector tokens and secrets.
_Avoid_: Prompt, memory, log

**Wake Activation**:
The person's local activation of the Companion through the default phrase “Hey BMO” or push-to-talk.
_Avoid_: Remote always-on audio stream

**Listening Session**:
The visibly indicated interval after Wake Activation in which the Companion receives speech for conversation or a Task.
_Avoid_: Hidden recording

**Code Task**:
A Task that inspects, modifies or tests a local software workspace.
_Avoid_: Published change

**Isolated Workspace**:
A separate local working copy or branch used by a Code Task to avoid altering the person's active workspace.
_Avoid_: Shared dirty workspace

**Recoverable Removal**:
A local-file removal that moves content to Trash rather than permanently destroying it.
_Avoid_: Permanent deletion

**Attention Mode**:
The person-selected operating mode that controls the Companion's interruption behavior while preserving permitted background work.
_Avoid_: Hidden automatic mode

**Attention Policy**:
The person's rule for when the Companion may interrupt with a spoken response versus a visual cue or digest.
_Avoid_: Notification preference

**Urgent Signal**:
A Signal whose time sensitivity or importance permits spoken interruption under the Attention Policy.
_Avoid_: Routine signal

**Ambient Source**:
An enabled source that emits Signals for Ambient Awareness.
_Avoid_: Permanent surveillance source

**Sensitive Surface**:
A source whose continuous observation or durable capture requires explicit opt-in.
_Avoid_: Default Ambient Source

**Voice Transport**:
The mechanism through which the Companion hears the person and speaks in return.
_Avoid_: Companion identity

**Degraded Conversation**:
An ongoing conversation in which the Companion uses an available fallback Voice Transport while preserving the same identity and context.
_Avoid_: Different Companion

**Mac-control Conflict**:
A situation in which more than one Task requires exclusive control of the person's Mac desktop.
_Avoid_: Parallel Task

**Work Priority**:
The deterministic order used to decide which competing work may run or interrupt: live person command, then urgent safety or deadline signal, then the active Task, then ordinary Standing Directive work.
_Avoid_: Attention Policy, arbitrary queue order

## Relationships

- One **Companion** may use different **Execution Engines** without changing identity
- An **Execution Engine** has no personal identity or relationship independent of the **Companion**
- A **Conversation Turn** may use the **Companion**'s memory but does not create a **Task**
- A **Task** is created for every request that reads from, changes, or operates an external system
- A read-only **Task** may access a relevant **Connected Service** without a **Task Approval**
- A **Task Approval** applies only to its **Task** and expires when that **Task** ends
- A Task Approval has a default two-hour maximum; extending it requires the person's direct approval
- A pending Task Approval or **Needs Decision** state issues **Approval Reminders** after 2, 5, and 10 minutes, then less frequently until it resolves or expires
- A **Task** becomes complete only when it has a **Verified Outcome**
- A **Task** may instead enter **Needs Decision**, **Blocked**, or **Failed** without becoming complete
- **Show Me** does not grant direct control of the external system
- **Take Over** ends the **Companion**'s control of the affected **Task** before the person interacts directly
- At most one **Mac-control Task** may run at a time
- Multiple compatible **Background Tasks** may run concurrently
- An **External Source** remains authoritative for its content and current state
- The **Companion** retains **Memory Records** and **Artifact References** about an **External Source**, not a shadow copy by default
- A **Memory Candidate** becomes **Active Memory** only when it is sufficiently low-sensitivity, high-confidence and corroborated, or when the person explicitly confirms it
- A **Procedure** may improve how a Task is carried out but may not override a **Safety Boundary**
- A **Procedure** is guidance from prior evidence, not a fixed sequence of computer actions
- The **Execution Engine** must observe current conditions, choose actions, recover and verify for every Task even when using a Procedure
- A **Delegated Action** is performed through the person's **Personal Account** and remains attributable there
- An approved **Unattended Task** may continue its authorized Delegated Actions while the person is away, subject to what the external system and device permit
- A **Mac-control Task** becomes a **Suspended Task** when macOS makes desktop control unavailable
- A **Suspended Task** resumes automatically when its required execution surface returns if its Task Approval remains valid and its scope has not changed
- **Cancellation** ends a **Task**, revokes its Task Approval, and prevents automatic resume
- **Cancellation** does not reverse already completed Delegated Actions unless the person explicitly requests a new Task to do so
- **Ambient Awareness** receives **Signals** from enabled sources without continuously invoking an Execution Engine
- A **Signal** may lead to a reminder, suggestion, or Task according to an authority policy
- A **Standing Directive** may authorize a **Directive Task** to notify, prepare work, or perform expressly defined Delegated Actions
- A **Directive Task** may not exceed the authority stated by its **Standing Directive**
- The Companion may create a **Directive Proposal**, but only the person may activate it as a **Standing Directive**
- An active Standing Directive provides **Directive Authority** for its matching Directive Tasks without a new Task Approval per occurrence
- Repeated failed or blocked **Directive Tasks** trigger **Directive Suspension** after a bounded threshold; the Companion preserves the evidence and notifies the person rather than retrying indefinitely
- A Persistent Directive remains active until the person changes it
- A Context-bound Directive expires when its associated context ends
- Every Task, Directive trigger, approval, Delegated Action and Verified Outcome is recorded in the Activity Ledger
- The Activity Ledger retains durable facts, timestamps, results and references; raw material belongs in the Evidence Cache
- Evidence Cache material expires unless it becomes a Pinned Artifact
- The **Evidence Retention Policy** discards raw microphone audio and screen frames after processing, and fetched source material after Verified Outcome or within 24 hours for unresolved work
- A Companion instance has exactly one Companion Owner in v1
- When the Stage is unavailable, the Companion uses a Compact Presence and restores the Stage when it returns
- A Task may use its Recovery Budget before entering Needs Decision rather than retrying indefinitely
- **Restart Recovery** restores Task context after an app or system restart, but must observe current state and revalidate authority before resuming; it never replays prior actions blindly
- The **First Vertical Slice** proves the entire Companion loop before adding connectors, ambient automation, or broader memory features
- The private local Stage uses **Stage Artwork**; it is not cleared for distribution by this design decision
- The first Stage implementation is a **Stage State Machine** with responsive BMO states before any fully polished animation sequence
- Payments, transfers, purchases, account/security changes, and sensitive/public disclosure are Reserved Actions
- A Standing Directive cannot supply Directive Authority for a Reserved Action
- Permanent deletion of local files or External Source content is a Prohibited Action; the Companion uses Recoverable Removal instead
- A Forget Request removes relevant local Memory Records, Artifact References and procedure candidates only after the person confirms its Deletion Preview
- A Forget Request does not delete the original content in its External Source
- The Activity Ledger retains only a content-free record that a Forget Request was completed
- The Companion Store resides locally for v1 and belongs to its Companion Owner
- A Companion Backup is created or restored only under the person's control
- In Offline Mode, a Service-dependent Task becomes a Suspended Task and may resume when its required service returns
- Screen Awareness is a Sensitive Surface enabled only by the person's explicit toggle and its raw frames use the Evidence Cache
- Password managers, secure-input fields, banking or financial apps, private browsing, and authentication or recovery flows are Protected Surfaces
- A Task may contain multiple Delegated Subtasks performed by Task Workers
- Only one Task Worker may control the Mac for a Task at a time
- Task Supervision keeps the Companion informed of Task Worker progress and final verified outcomes
- Task Workers emit Progress Events at start, milestones, errors, Needs Decision and completion
- Task Supervision uses Progress Check-ins adaptively for long-running work and speaks only when the Attention Policy permits meaningful updates
- The Companion gives a Completion Brief by default; Show Me and the Activity Ledger provide the supporting detail on demand
- Ambient Awareness and Task Supervision operate within the Compute Budget according to the Token Economy
- When the Compute Budget is constrained, critical reminders remain active while lower-priority interpretation is deferred or batched
- V1 uses a Local Gate rather than a resident local neural model; Execution Engine reasoning remains external
- In Resource-aware Mode, wake activation and critical Signals remain active while non-urgent workers, discovery and consolidation are deferred or throttled
- The Primary Engine owns conversation, Task reasoning, coding, browser or computer control, permissions and final verification
- A Utility Model may produce bounded drafts or candidates but may not grant authority, control the Mac, perform Delegated Actions or determine a Verified Outcome
- A Utility Packet excludes credentials, Protected Surface content, raw audio, raw screenshots and unbounded personal source history
- A Utility Model has no direct tool, connector, file, browser, Mac or credential access
- Every Utility Packet is handled as a Stateless Utility Call; durable personal context remains in the Companion Store
- The Routing Policy assigns deterministic filtering to the Local Gate, bounded transforms to the Utility Model, and conversation, consequential reasoning, action and verification to the Primary Engine
- Uncertain or consequential Utility Model output requires Escalation before it affects an action or durable knowledge
- The Primary Engine reconciles a Worker Disagreement using source evidence; the person is consulted only for a genuine preference or value choice
- Self-improvement may create a Companion Update Proposal but may not install, run, restart or deploy it without the person's explicit approval
- A Capability Connection requires direct approval and cannot be created by a Standing Directive or Procedure
- A **Capability Degradation** suspends only its dependent Tasks and Standing Directives, leaving unrelated work available; resumption requires a valid reconnected Capability Connection
- The **Personal Planning Pack** is the first connector release and combines Gmail, Google Calendar, and Todoist without copying their raw data into the Companion Store
- The first opt-in **Standing Directive** is a **Morning Briefing Directive** built on the Personal Planning Pack
- Capability Discovery may create Capability Recommendations but may not create a Capability Connection
- A Capability Recommendation is surfaced immediately when a Task is blocked or repeated friction establishes need; otherwise it appears in the Capability Digest
- Capability Discovery performs Capability Vetting before producing a Capability Recommendation
- Activity Ledger data and diagnostics remain in the Companion Store unless the person creates a Diagnostic Export
- Connector credentials remain in the Credential Store and never enter Memory Records, Utility Packets, Procedures, Activity Ledger content or screen evidence
- Revoking a Capability Connection removes its credentials and stops related Tasks
- Wake Activation is detected locally; a Listening Session begins only after Wake Activation and is visibly indicated
- “Hey BMO” is the default Wake Activation phrase; push-to-talk remains an always-available fallback
- An approved Code Task may inspect, modify and test the local workspace
- Committing, pushing, opening a pull request, publishing or deploying a Code Task result is a Reserved Action
- A Code Task uses an Isolated Workspace by default when the repository supports it
- A dirty or non-isolatable workspace requires Needs Decision before a Code Task changes it
- A Task uses Recoverable Removal for local-file cleanup; permanent deletion is a Prohibited Action
- Attention Mode may be Normal, Focus, Quiet or Away; the Companion may suggest but not silently change it
- An **Urgent Signal** may produce a spoken interruption according to the **Attention Policy**
- Non-urgent Signals remain visual or enter a digest while the person is focused or in a call
- Calendar, Todoist, Gmail metadata, task status and normal system notifications are default Ambient Sources after connection
- A Sensitive Surface is not an Ambient Source until the person explicitly enables it
- A change in Voice Transport does not change the Companion's identity, memory, or Task history
- An Urgent Signal always receives attention under the Attention Policy, but does not automatically preempt a Mac-control Task
- A Mac-control Conflict is resolved by the person choosing whether the active Task continues or is cancelled
- Competing work follows **Work Priority**: live person command, then urgent safety or deadline signal, then the active Task, then ordinary Standing Directive work; lower-priority work waits

## Example dialogue

> **Dev:** “If the current **Execution Engine** becomes unavailable, does the person meet a different assistant?”
> **Domain expert:** “No—the **Companion** remains the same and may temporarily use another **Execution Engine**.”

> **Dev:** “Is ‘what is on my calendar today?’ only a **Conversation Turn** because it is quick?”
> **Domain expert:** “No—it is a **Task** because it reads an external service; ‘what did we decide last week?’ remains a **Conversation Turn**.”

> **Dev:** “Does ‘find Sam’s email’ need a prompt?”
> **Domain expert:** “Not when Gmail is a **Connected Service** and the **Task** is read-only; sending a reply needs a **Task Approval**.”

> **Dev:** “What happens if an approval waits unanswered?”
> **Domain expert:** “The Task remains paused and emits **Approval Reminders** after 2, 5, and 10 minutes, then less often, until the person responds, cancels it, or the approval window expires.”

> **Dev:** “Does a Task waiting for missing information get forgotten?”
> **Domain expert:** “No—its **Needs Decision** state uses the same **Approval Reminder** schedule until the person resolves or cancels it.”

> **Dev:** “Is ‘send this email’ complete when a draft exists?”
> **Domain expert:** “No—the **Task** is complete only after a **Verified Outcome** confirms sending; otherwise it may be **Needs Decision**, **Blocked**, or **Failed**.”

> **Dev:** “Can the person type into the browser shown in **Show Me** while the **Companion** is working?”
> **Domain expert:** “No—**Show Me** is read-only; the person uses **Take Over** first.”

> **Dev:** “Can the Companion search Gmail while it edits a repository?”
> **Domain expert:** “Yes, the Gmail search is a **Background Task**; a second **Mac-control Task** waits until the repository task ends, is interrupted, or is taken over.”

> **Dev:** “Does the Companion own the interview email after reading it?”
> **Domain expert:** “No—Gmail remains the **External Source**; the Companion retains an **Artifact Reference** and relevant **Memory Records**.”

> **Dev:** “Can ‘Rachit uses Todoist’ become durable automatically?”
> **Domain expert:** “Yes, if it is a sufficiently corroborated and low-sensitivity **Memory Candidate**; a sensitive personal inference remains a **Memory Candidate** until confirmed.”

> **Dev:** “May a learned release **Procedure** publish without asking?”
> **Domain expert:** “No—a **Procedure** can prepare and verify the release, but it cannot override the **Safety Boundary** requiring approval to publish.”

> **Dev:** “Does a learned navigation Procedure force the same browser shortcut every time?”
> **Domain expert:** “No—the **Procedure** guides what to verify, while the **Execution Engine** chooses actions from the current situation.”

> **Dev:** “Who sends an email prepared by the Companion?”
> **Domain expert:** “The person's **Personal Account** sends the **Delegated Action**; the Companion has no separate identity.”

> **Dev:** “May an approved inbox-cleanup Task archive mail after the person leaves?”
> **Domain expert:** “Yes—when approved as an **Unattended Task**, it may continue authorized **Delegated Actions** until it ends or the approval expires.”

> **Dev:** “What happens to an approved browser Task while the Mac is locked?”
> **Domain expert:** “It becomes a **Suspended Task** and resumes after unlock if its approval remains valid.”

> **Dev:** “Does ‘stop’ undo an email that has already been sent?”
> **Domain expert:** “No—**Cancellation** prevents future work; undoing an already completed action requires an explicit new Task.”

> **Dev:** “Must the person ask before the Companion notices an upcoming meeting?”
> **Domain expert:** “No—Ambient Awareness receives the calendar **Signal** and can decide whether it merits attention.”

> **Dev:** “May the Companion create an interview-prep checklist when a recruiter email arrives?”
> **Domain expert:** “Yes, if a **Standing Directive** authorizes it; the resulting work is a **Directive Task**.”

> **Dev:** “Can a repeated morning-planning pattern become automatic by itself?”
> **Domain expert:** “No—the Companion may present a **Directive Proposal**, but it becomes a **Standing Directive** only when the person activates it.”

> **Dev:** “Does every recruiter email require a fresh approval to create the authorized Todoist checklist?”
> **Domain expert:** “No—the active Standing Directive supplies **Directive Authority** for that exact Delegated Action.”

> **Dev:** “Does the Microsoft interview Directive stay active after the interview?”
> **Domain expert:** “No—it is a **Context-bound Directive**; a daily briefing is a **Persistent Directive**.”

> **Dev:** “How can the person see what an unattended Directive did?”
> **Domain expert:** “Every relevant Signal, Task, action and outcome appears in the **Activity Ledger**.”

> **Dev:** “Are screenshots from every Task kept forever?”
> **Domain expert:** “No—the **Evidence Retention Policy** discards them after processing unless the person makes one a **Pinned Artifact**.”

> **Dev:** “Can two people use the same Companion instance with separate memories?”
> **Domain expert:** “No—v1 has one **Companion Owner** and one authority model.”

> **Dev:** “What happens if the external monitor disconnects?”
> **Domain expert:** “The Companion moves to a **Compact Presence** and restores the **Stage** when the monitor returns.”

> **Dev:** “What happens when a browser action lands in the wrong place?”
> **Domain expert:** “The Task uses its **Recovery Budget** to observe and try alternatives; if it remains uncertain, it enters Needs Decision.”

> **Dev:** “What happens when BMO restarts while a browser Task is halfway through?”
> **Domain expert:** “It performs **Restart Recovery**: restores the Task context, observes the current browser state, revalidates authority, and only then decides whether it can safely continue.”

> **Dev:** “Can a Standing Directive authorize a recurring purchase?”
> **Domain expert:** “No—a purchase is a **Reserved Action** and always needs fresh direct confirmation.”

> **Dev:** “Can BMO permanently delete a file after the person approves it?”
> **Domain expert:** “No—permanent file deletion is a **Prohibited Action**; BMO uses Recoverable Removal.”

> **Dev:** “What happens when the person says ‘forget the Microsoft interview’?”
> **Domain expert:** “The Companion shows a **Deletion Preview**; after confirmation, the **Forget Request** removes local knowledge while leaving Gmail and Calendar unchanged.”

> **Dev:** “Does the Companion silently replicate personal memory to a cloud account?”
> **Domain expert:** “No—the local **Companion Store** is backed up only through a person-controlled **Companion Backup**.”

> **Dev:** “What happens to an online research Task when the internet drops?”
> **Domain expert:** “The Companion enters **Offline Mode** and the research becomes a **Service-dependent Task** that is suspended until service returns.”

> **Dev:** “May the Companion understand the active laptop app without a prompt?”
> **Domain expert:** “Only when the person enables **Screen Awareness**, which remains visibly indicated and uses the Evidence Cache.”

> **Dev:** “Can Screen Awareness watch a password-manager window?”
> **Domain expert:** “No—it is a **Protected Surface** unless the person explicitly overrides that exclusion for a specific case.”

> **Dev:** “Who tells the person the result after several workers research a Task?”
> **Domain expert:** “The Companion uses **Task Supervision** to inspect the **Delegated Subtasks** and gives the final verified update.”

> **Dev:** “How does BMO stay aware of a long code-analysis Task?”
> **Domain expert:** “Workers emit **Progress Events**; if progress is quiet, Task Supervision uses an adaptive **Progress Check-in** rather than continuously polling.”

> **Dev:** “How much does BMO say after a Task succeeds?”
> **Domain expert:** “She gives a **Completion Brief**; the person opens Show Me or the Activity Ledger for full detail.”

> **Dev:** “What happens when BMO has spent most of its daily compute allowance?”
> **Domain expert:** “The Token Economy keeps critical reminders active and defers lower-priority work within the remaining **Compute Budget**.”

> **Dev:** “Does v1 run a local language model continuously to classify every notification?”
> **Domain expert:** “No—the Local Gate uses low-overhead filtering and sends only selected Signals to the Execution Engine.”

> **Dev:** “What happens when the Mac is low on battery during background research?”
> **Domain expert:** “The Companion enters **Resource-aware Mode** and preserves critical presence while deferring non-urgent work.”

> **Dev:** “May the lower-cost model decide whether to publish a result?”
> **Domain expert:** “No—the **Utility Model** may prepare a candidate, but the **Primary Engine** retains authority and verification.”

> **Dev:** “May the Utility Model receive the entire inbox to find urgent mail?”
> **Domain expert:** “No—it receives a minimized **Utility Packet** for a specific classification purpose.”

> **Dev:** “May the Utility Model directly archive the mail it classified?”
> **Domain expert:** “No—the Utility Model has no tool access; only the Primary Engine may perform a Delegated Action.”

> **Dev:** “Does the Utility Model remember prior requests about the person?”
> **Domain expert:** “No—each request is a **Stateless Utility Call**; the Companion Store remains the sole durable memory.”

> **Dev:** “What happens when a low-cost email classifier is unsure whether an email is urgent?”
> **Domain expert:** “The **Routing Policy** performs an **Escalation** to the Primary Engine.”

> **Dev:** “Two research workers report different dates for the same event—who resolves it?”
> **Domain expert:** “The Primary Engine resolves the **Worker Disagreement** against source evidence unless the distinction is the person's preference.”

> **Dev:** “May BMO fix its own code after finding a repeated bug?”
> **Domain expert:** “It may create a tested **Companion Update Proposal**, but the person must approve its installation.”

> **Dev:** “May BMO install a Todoist plugin because an existing Directive needs it?”
> **Domain expert:** “No—the person must directly approve the new **Capability Connection**.”

> **Dev:** “What does the first connector release provide?”
> **Domain expert:** “The **Personal Planning Pack** joins Gmail, Google Calendar, and Todoist for live planning and reminders; reads are available after connection and writes remain Task-scoped.”

> **Dev:** “What is the first opt-in proactive behavior?”
> **Domain expert:** “A **Morning Briefing Directive** gives a concise BMO briefing from the Personal Planning Pack at the person's configured morning trigger.”

> **Dev:** “What happens if Todoist access expires while a Gmail Task is running?”
> **Domain expert:** “That is a **Capability Degradation**: Todoist-dependent work suspends and asks the person to reconnect, while the Gmail Task continues.”

> **Dev:** “May BMO look for a connector after repeated Tasks struggle with a service?”
> **Domain expert:** “Yes—Capability Discovery may create a Capability Recommendation, but the person still approves any Capability Connection.”

> **Dev:** “Does every newly found connector interrupt the person?”
> **Domain expert:** “No—only a currently blocked Task or repeated friction surfaces it immediately; other recommendations enter the Capability Digest.”

> **Dev:** “May BMO recommend an unknown plugin just because it matches a Task?”
> **Domain expert:** “Only after Capability Discovery performs **Capability Vetting** and explains the connector's authority and risk.”

> **Dev:** “Does BMO upload task logs for analytics?”
> **Domain expert:** “No—logs remain local unless the person creates a **Diagnostic Export**.”

> **Dev:** “Can a learned Procedure contain a Gmail access token?”
> **Domain expert:** “No—credentials remain only in the protected **Credential Store**.”

> **Dev:** “Is microphone audio continuously sent to the Companion service?”
> **Domain expert:** “No—local ‘Hey BMO’ **Wake Activation** or push-to-talk starts a visible **Listening Session** before audio is sent.”

> **Dev:** “May BMO fix a local bug without asking at every edit?”
> **Domain expert:** “Yes, within an approved **Code Task**; publishing the change remains a **Reserved Action**.”

> **Dev:** “May BMO edit a repository while the person has unrelated uncommitted changes?”
> **Domain expert:** “It uses an **Isolated Workspace** when possible; otherwise the Code Task enters Needs Decision.”

> **Dev:** “May BMO permanently erase a large local cache during cleanup?”
> **Domain expert:** “No—it uses **Recoverable Removal**; permanent deletion is a **Prohibited Action**.”

> **Dev:** “May BMO silence routine interruptions while the person studies?”
> **Domain expert:** “Yes—the person selects a Focus or Quiet **Attention Mode**; the Companion may suggest a mode but does not change it silently.”

> **Dev:** “May the Companion speak while the person is on a call?”
> **Domain expert:** “Only for an **Urgent Signal** under the **Attention Policy**; routine work waits visually or in a digest.”

> **Dev:** “Does Ambient Awareness continuously OCR the desktop?”
> **Domain expert:** “No—the desktop is a **Sensitive Surface** and requires explicit opt-in; calendar and Todoist are default **Ambient Sources** once connected.”

> **Dev:** “What happens if the preferred realtime service is unavailable?”
> **Domain expert:** “The Companion continues in a **Degraded Conversation** through another **Voice Transport**, without becoming a different assistant.”

> **Dev:** “An interview reminder needs the Mac while a repository Task is running—what happens?”
> **Domain expert:** “The Companion speaks about the Urgent Signal; the person resolves the **Mac-control Conflict** by continuing or cancelling the active Task.”

## Flagged ambiguities

- “Agent” previously referred both to the persistent character and to the software performing a task — resolved: these are the **Companion** and the **Execution Engine**, respectively.
- “Quick request” previously blurred conversational and external work — resolved: external-system work is always a **Task** regardless of duration.
- “Connected” previously implied unrestricted access — resolved: a **Connected Service** permits read-only work; consequential work requires a **Task Approval**.
- “One approval” previously lacked a safe lifetime and follow-up behavior — resolved: it has a two-hour default maximum and pending work uses **Approval Reminders**.
- “Needs Decision” previously could make a Task vanish silently — resolved: it uses the same **Approval Reminder** schedule as a pending approval.
- “Done” previously could mean either attempted or verified — resolved: only a **Verified Outcome** completes a **Task**.
- “Show Me” previously could imply shared control — resolved: it is read-only; **Take Over** is the explicit control handoff.
- “Parallel tasks” previously did not distinguish desktop control from background work — resolved: only one **Mac-control Task** runs at once.
- “Remember everything” previously implied copying every service — resolved: **External Sources** remain canonical while the Companion retains learned context and references.
- “Remembered” previously blurred proposed and durable knowledge — resolved: the Companion distinguishes a **Memory Candidate** from **Active Memory**.
- “Self-improvement” previously could imply self-authorized privilege expansion — resolved: **Procedures** never override a **Safety Boundary**.
- “Learned workflow” previously could imply a brittle script — resolved: a **Procedure** guides current-state reasoning rather than fixing action sequences.
- “Agent identity” previously left ownership unclear — resolved: all **Delegated Actions** use the person's **Personal Account**.
- “Approval” previously implied the person must remain present — resolved: an **Unattended Task** may continue within its approved scope.
- “Unable to act while locked” previously implied failure — resolved: a temporarily unavailable **Mac-control Task** is a **Suspended Task**.
- “Stop” previously left approval state unclear — resolved: **Cancellation** revokes the Task's remaining authority immediately.
- “Always active” previously implied continuously polling a model — resolved: **Ambient Awareness** is event-driven and evaluates detected **Signals**.
- “Proactive” previously left authority undefined — resolved: autonomous work occurs only through a **Standing Directive** and its **Directive Tasks**.
- “Learned directive” previously implied automatic authority — resolved: inferred automation remains a **Directive Proposal** until activated.
- “Standing directive” previously left recurring approval unclear — resolved: its **Directive Authority** covers only its explicitly named actions.
- “Automation lifetime” previously left stale authority possible — resolved: Directives are either **Persistent** or **Context-bound**.
- “Autonomous work” previously could be invisible — resolved: it is recorded in the **Activity Ledger**.
- “Audit trail” previously implied retaining all raw material forever — resolved: durable records remain while raw material uses the **Evidence Cache** unless pinned.
- “Short-lived evidence” previously lacked an enforceable default — resolved: the **Evidence Retention Policy** removes raw audio and screen data after processing and fetched content after completion or 24 hours.
- “Personal” previously left multi-user scope open — resolved: v1 has exactly one **Companion Owner**.
- “Full-screen” previously implied taking over every display — resolved: the Companion owns a selected **Stage** and otherwise uses a **Compact Presence**.
- “Recovery” previously could imply unlimited autonomous retries — resolved: every Task has a bounded **Recovery Budget**.
- “Restart” previously could cause duplicated Mac actions — resolved: **Restart Recovery** re-observes current state and revalidates authority before it continues.
- “V1 scope” previously risked parallel partial subsystems — resolved: the **First Vertical Slice** proves the full interaction, authority, execution and reporting loop first.
- “Character direction” previously left the visual identity open — resolved: the private local Stage uses direct **Stage Artwork** based on BMO.
- “Character animation” previously implied a large up-front art project — resolved: the first **Stage State Machine** delivers responsive interaction states before cinematic polish.
- “Standing authority” previously could include every consequence — resolved: a **Reserved Action** always needs fresh direct confirmation.
- “Approval” previously could permit permanent file deletion — resolved: it is a **Prohibited Action**; only Recoverable Removal is allowed.
- “Forget” previously could imply either local or source deletion — resolved: a **Forget Request** deletes local knowledge only after a confirmed **Deletion Preview**.
- “Personal backup” previously could imply automatic cloud replication — resolved: v1 uses a local **Companion Store** and person-controlled **Companion Backup**.
- “Offline” previously implied the Companion disappears — resolved: it enters **Offline Mode** and only Service-dependent Tasks suspend.
- “Screen context” previously could be captured invisibly — resolved: **Screen Awareness** is explicit, indicated and short-lived by default.
- “Screen Awareness” previously could include every active app — resolved: a **Protected Surface** is automatically excluded.
- “Delegation” previously could make BMO a detached interface — resolved: **Task Supervision** keeps the Companion responsible for worker progress and the final update.
- “Monitoring” previously implied costly continuous polling — resolved: **Progress Events** are primary and **Progress Check-ins** are adaptive.
- “Task result” previously implied a full spoken transcript — resolved: the Companion gives a concise **Completion Brief** by default.
- “Always active” previously implied unbounded model use — resolved: Ambient Awareness follows a configurable **Compute Budget** and Token Economy.
- “Local efficiency” previously implied another always-running model — resolved: v1 uses a non-neural **Local Gate**.
- “Always active” previously implied ignoring device limits — resolved: **Resource-aware Mode** throttles non-urgent work under resource pressure.
- “Single model” previously ignored available low-cost capacity — resolved: the **Primary Engine** remains authoritative while a **Utility Model** handles bounded background transforms.
- “Utility model context” previously could imply full personal-data export — resolved: every request uses a minimized **Utility Packet**.
- “Utility model” previously could imply a second agent with tools — resolved: it is transformation-only with no direct system access.
- “Utility model efficiency” previously could imply a second long-term memory — resolved: each request is a **Stateless Utility Call**.
- “Model selection” previously could be an opaque autonomous choice — resolved: a deterministic **Routing Policy** uses **Escalation** for uncertainty or consequence.
- “Parallel workers” previously could imply a vote — resolved: the Primary Engine reconciles a **Worker Disagreement** from evidence.
- “Self-improvement” previously could include silent code changes — resolved: code changes remain **Companion Update Proposals** until approved.
- “Standing authority” previously could expand the Companion's capabilities — resolved: every new **Capability Connection** needs direct approval.
- “Connector discovery” previously could imply automatic installation — resolved: Capability Discovery creates only a **Capability Recommendation**.
- “Continuous discovery” previously could create recommendation noise — resolved: non-urgent findings wait in the **Capability Digest**.
- “Useful connector” previously implied trusted connector — resolved: every recommendation follows **Capability Vetting**.
- “Diagnostics” previously could imply hidden cloud telemetry — resolved: they leave the Companion Store only through a **Diagnostic Export**.
- “Connector memory” previously could expose secrets — resolved: credentials remain only in the protected **Credential Store**.
- “One broken connector” previously could halt the Companion — resolved: **Capability Degradation** suspends only dependent work until reconnection.
- “Initial integrations” previously risked disconnected features — resolved: the **Personal Planning Pack** centers Gmail, Calendar, and Todoist on one daily planning outcome.
- “First proactive automation” previously had no concrete user value — resolved: the opt-in **Morning Briefing Directive** turns the Personal Planning Pack into a daily spoken briefing.
- “Always available” previously implied remote always-on audio — resolved: local **Wake Activation** starts a visible **Listening Session**.
- “Coding autonomy” previously left publication scope unclear — resolved: local work belongs to a Code Task while remote or published changes are Reserved Actions.
- “Autonomous coding” previously could disturb open work — resolved: a Code Task uses an **Isolated Workspace** by default.
- “Cleanup” previously could mean irreversible deletion — resolved: ordinary removal is **Recoverable Removal**.
- “Attention behavior” previously could change invisibly — resolved: the person selects an explicit **Attention Mode**.
- “Always active” previously left interruptions unconstrained — resolved: the **Attention Policy** reserves speech during focused work for an **Urgent Signal**.
- “Always observing” previously implied every available surface — resolved: default **Ambient Sources** are limited and a **Sensitive Surface** requires opt-in.
- “Realtime failure” previously implied the Companion disappears — resolved: it continues through a **Degraded Conversation** with another Voice Transport.
- “Urgent” previously implied automatic desktop interruption — resolved: an Urgent Signal notifies, while the person resolves any **Mac-control Conflict**.
- “Concurrent work” previously had no stable ordering — resolved: **Work Priority** makes direct commands and urgent conditions outrank routine directive work.
