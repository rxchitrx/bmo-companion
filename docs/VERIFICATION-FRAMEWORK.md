# Verification framework

`electron/outcome-verifier.ts` is the deterministic evidence boundary between a scoped worker result and the execution kernel's final `verified` boolean.

## Structured evidence

Workers may return `ExecutionResult.verificationEvidence`. Each record has a stable id, kind, source, polarity, strength and bounded statement. Evidence is limited to 32 records; ids, sources and statements are validated and bounded. Supported kinds cover worker contracts, protocol settlement, state observations, tool results, artifacts and reconciliation observations.

The verifier never executes a tool, probes state, connects a service or grants authority. It only evaluates the supplied record set.

## Deterministic decision

`OutcomeVerifier.verify(request)` returns a versioned `VerificationDecision` with:

- `verified` or `unverified` status;
- ordered reason codes and the evidence ids associated with each reason;
- counts for considered, supporting, contradictory and direct-supporting evidence.

Verification requires all of the following:

1. A non-empty outcome summary.
2. The scoped worker's verified claim.
3. No reconciliation requirement.
4. At least one valid, direct supporting evidence record.
5. No contradictory evidence.

Missing, indirect-only, malformed, duplicate, contradictory or over-limit evidence fails closed with separate reason codes. Contradictory evidence always prevents verification even when supporting evidence is also present.

## Kernel integration contract

`ExecutionResult` now carries optional `verificationEvidence` from a worker and `verificationDecision` from the kernel. `MinimalExecutionKernel` is the only production component that sets the final `verified` value from the verifier decision. `TaskRuntime` continues to consume that boolean without any authority or lifecycle-policy change.

Existing workers that omit `verificationEvidence` are adapted to one direct `worker-contract` record only when their current scoped verification contract reports `verified: true`. This preserves the Task 5 contract while allowing workers to migrate to explicit protocol, state or tool evidence. An explicitly supplied empty array does not use the compatibility adapter and therefore fails as missing evidence.

Custom verifier implementations may be injected through `MinimalExecutionKernelOptions.verifier`, but they receive only the typed `VerificationRequest`; they receive no execution authority. The kernel returns the bounded evidence and decision for future evaluation/trajectory consumers. Evidence text must remain out of diagnostic event payloads; current kernel lifecycle events expose only decision metadata and reason codes.

## Out of scope

This framework does not change approval, cancellation, recovery, replay, cost budgets, connectors, UI, or Task status transitions. Domain-specific evidence collection remains the responsibility of scoped workers and later integrations.
