# Capability selection contract

BMO now builds a small, deterministic capability manifest before connector discovery returns any action schema. The selector is a context boundary only: it does not connect a service, request permission, prepare a call, execute a read, create a write Task, or grant authority.

## Inputs and output

`selectCapabilityManifest(connectors, request)` accepts:

- a registered connector catalog;
- a bounded natural-language task description;
- optional exact `service.action` ids already requested by an upstream planner.

It returns a serializable `CapabilityManifest` containing only allowlisted, relevant action summaries. The default manifest is capped at 500 request characters, 24 unique request tokens, 16 exact requested ids, 4 services and 8 actions. Empty or unrelated tasks return an empty manifest. Ranking and tie-breaking are stable, so the same catalog and request produce the same ordered result.

The explicit `MODEL_VISIBLE_CAPABILITY_ALLOWLIST` is fail-closed. Registering a new connector action does not expose its schema until its stable id is reviewed and added to that allowlist.

## Authority boundary

The manifest carries `authority: "selection-only"`. Consumers must treat that as a constraint, not a credential:

1. Selection never changes connector availability or connection state.
2. Selection never bypasses `ConnectorGateway.prepare()` argument validation.
3. Reads still execute only through the existing connector bridge and remain cancellable.
4. Writes still create one scoped Task and use the existing approval, cancellation and Verified Outcome lifecycle.
5. A selected capability may become unavailable before execution; the execution kernel must re-resolve and validate the exact service/action at call time.

## Context Packet integration

The execution kernel now accepts the returned manifest as a separate, replaceable selection and normalizes it to stable capability ids plus version/count metadata. It does not serialize connector implementations, `run` functions, credentials, connection setup details, or the full connector catalog. A new Task replaces the prior selection rather than unioning capabilities across turns.

Task 1 metadata telemetry already observes the boundary through the `connectors.capabilities` / `selection.completed` context snapshot. It records request/manifest size and hashes plus selected/omitted counts, not the raw task or schemas.

## Execution-kernel integration

The execution kernel uses `selectedCapabilityIds` to reject connector drift before invoking its single scoped worker, while continuing to treat `ConnectorGateway.prepare()` and the Task runtime as authoritative. Selection is never proof of permission, approval, connectivity, or execution. Exact requested ids are retained only when they are allowlisted and within the fixed manifest limits.
