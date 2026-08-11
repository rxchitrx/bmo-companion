# Permissions and Task lifecycle

`electron/permission-lifecycle.ts` defines the production authority contract for
one scoped Task. It does not grant credentials or add capabilities.

## Policy decision

Every Task carries a persisted `ScopedTaskAuthority` with an explicit decision:

- `ask`: no Mac-control worker may start; direct owner approval is required.
- `allow`: one worker may run while the exact scope and expiry remain valid.
- `deny`: authority is revoked and no worker may start or resume.

The scope binds the Task id, Task kind, worker id, objective hash, and sorted
capability ids. A changed objective, worker, kind, or capability set fails closed.
The goal itself is not duplicated into the authority record.

Approval expires after the existing two-hour Task window. Missing or expired
authority returns `ask`; revoked or mismatched authority returns `deny`.

## Lifecycle

1. `TaskRuntime.create()` persists `ask` and waits for owner approval.
2. `approve()` persists a scoped, expiring `allow` before execution.
3. `pause()` aborts the active worker, marks authority paused, and requires
   read-only recovery before another worker can start.
4. `resume()` is an alias for the existing safe recovery gate. It checks scope
   and expiry, calls the `RecoveryObserver`, and only then reactivates authority.
5. `deny()`, `cancel()`, expiry, failure, or completion revoke or deactivate the
   grant. Late worker progress and results remain ignored by `TaskRuntime`.

Restored legacy Tasks synthesize a scoped record from their existing persisted
approval window, then immediately pause it for recovery. No prior Mac action is
replayed.

## One-worker invariant

`MinimalExecutionKernel` validates the scoped authority against the capability
manifest immediately before worker startup. A kernel instance admits at most one
Mac-control worker at a time and does not queue, retry, or overlap a second one.
`TaskRuntime` also waits for an aborted worker to settle before a resumed worker
can start.

This layer intentionally does not implement outcome verification, cost budgets,
trajectory replay, UI, connectors, or new capabilities.
