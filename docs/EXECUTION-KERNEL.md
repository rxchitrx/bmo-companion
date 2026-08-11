# Minimal execution kernel

`electron/execution-kernel.ts` is the narrow production orchestration seam for
approved Tasks:

1. Build one bounded `TaskContextPacket`.
2. Build one selection-only `ExecutionCapabilityManifest`.
3. Invoke one scoped worker exactly once.
4. Project versioned, ordered `KernelLifecycleEvent` records.
5. Evaluate structured evidence through one deterministic verifier.
6. Convert the verifier decision through one `VerifiedOutcome` boundary.

`TaskRuntime` remains the owner of approval, cancellation, recovery, durable Task
status and Activity Ledger writes. The kernel validates Task Runtime's scoped,
expiring authority immediately before worker startup; it does not grant that
authority, retry a worker, create Tasks, or publish UI state.

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
- `kernel.permission_decided`
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

A result crosses the boundary only when the Task 7 verifier returns `verified`.
The verifier requires a non-empty summary, the worker's verified claim, direct
supporting evidence, no contradiction and no reconciliation requirement. Missing
or contradictory evidence is normalized to an unverified outcome before
`TaskRuntime` receives it. The typed evidence and decision contract is documented
in [VERIFICATION-FRAMEWORK.md](./VERIFICATION-FRAMEWORK.md).

## Integration requirements

- Production composition must wrap `ConnectorRoutingTaskExecutor` in
  `MinimalExecutionKernel` and provide `ConnectorGateway.selectCapabilities`.
- New scoped worker implementations must consume the supplied Context Packet and
  execution manifest rather than rebuilding broader ambient context.
- New connector actions must remain explicitly allowlisted by Task 4 before a
  connector Task can reach its worker.
- Production execution must carry a `ScopedTaskAuthority` whose Task, objective,
  worker and capability scope exactly match the prepared execution manifest.
- Live canary wiring, cost guardrails, Python evaluation changes, UI additions
  and outcome-policy changes remain separate future work.
