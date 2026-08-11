# Minimal execution kernel

`electron/execution-kernel.ts` is the narrow production orchestration seam for
approved Tasks:

1. Build one bounded `TaskContextPacket`.
2. Build one selection-only `ExecutionCapabilityManifest`.
3. Invoke one scoped worker exactly once.
4. Project versioned, ordered `KernelLifecycleEvent` records.
5. Convert the worker result through one `VerifiedOutcome` boundary.

`TaskRuntime` remains the owner of approval, cancellation, recovery, durable Task
status and Activity Ledger writes. The kernel does not grant authority, retry a
worker, create Tasks, change lifecycle policy, or publish UI state.

## Cost and runaway guardrails

Every kernel run has fixed positive ceilings for total tokens, elapsed time,
tool calls and turns. It also detects consecutive repeated structural tool
shapes and repeated failures. Production defaults are 250,000 total tokens,
five minutes, 32 tool calls, four turns, three matching action shapes and three
matching failures. Invalid overrides fall back to those defaults.

The first exhausted guardrail aborts the one scoped worker and wins
deterministically. Token exhaustion returns `summarize`, time exhaustion returns
`stop`, and tool/turn/loop/failure exhaustion returns `needs-decision`. These are
kernel outcomes only: `TaskRuntime` continues to own Task status and authority,
and the kernel never retries or changes verification policy.

Token counts come from the existing cumulative usage callback. Codex reports
turn starts and non-message protocol items through an execution-only observer.
Loop/failure keys contain only structural item type/server/tool identity and are
never included in events or diagnostics. Guardrail telemetry contains limits,
counters, reason and disposition—not goals, prompts, tool arguments, results or
failure text.

## Capability binding

Codex Tasks receive the bounded capability reference already selected by their
Context Packet: baseline, workspace, or Computer Use. Connector Tasks request
their exact `service.action` id through Task 4's deterministic allowlisted
selector. If that exact id is absent from the selected manifest, the kernel fails
closed before invoking the connector worker.

The execution manifest is a selection/routing boundary, not dynamic tool loading
or a hard capability lease. It contains stable ids and selection metadata only. It is not
a credential, connection status, permission, approval, connector implementation,
or broad catalog. The connector gateway still performs argument validation and
re-resolves the action at execution time.

## Lifecycle contract

Every event carries kernel version, run id, and monotonic sequence:

- `kernel.started`
- `kernel.context_prepared`
- `kernel.capabilities_selected`
- `kernel.worker_started`
- `kernel.worker_progress`
- `kernel.worker_completed`
- `kernel.outcome_verified` or `kernel.outcome_unverified`
- `kernel.failed` for thrown failures

Progress event metadata contains only length and hash. Production diagnostics
sanitize outcome summaries, and Context Packet telemetry retains measurements,
provenance and hashes rather than raw Task content. Event observers cannot break
execution.

## VerifiedOutcome boundary

A result crosses the boundary only when the single worker returns a non-empty
summary, `verified: true`, and does not require reconciliation. Contradictory or
empty results are normalized to an unverified outcome before `TaskRuntime`
receives them. Codex still establishes its verified claim from protocol
settlement plus the required output prefix; connector workers still establish it
from the validated connector result.

## Integration requirements

- Production composition must wrap `ConnectorRoutingTaskExecutor` in
  `MinimalExecutionKernel` and provide `ConnectorGateway.selectCapabilities`.
- New scoped worker implementations must consume the supplied Context Packet and
  execution manifest rather than rebuilding broader ambient context.
- New connector actions must remain explicitly allowlisted by Task 4 before a
  connector Task can reach its worker.
- Live canary wiring, Python evaluation changes, UI additions
  and lifecycle-policy extensions remain separate future work.
