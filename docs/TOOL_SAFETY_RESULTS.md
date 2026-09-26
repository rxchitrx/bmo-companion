# Tool safety implementation and verification

Measured 25 September 2026. The run used the current local checkout and the
subscription-backed Codex app-server. No Platform API was used.

This is the historical Codex coding result. Pi became BMO's default coding
worker on 26 September; see [`PI_VS_CODEX_CODING_2026-09-26.md`](PI_VS_CODEX_CODING_2026-09-26.md).

| Requirement | Implemented boundary | Evidence and outcome |
| --- | --- | --- |
| Risk and exact approval | Closed connector and BMO tool registry; writes require an exact Task, action, argument hash, and unexpired approval. Privileged escalations are denied after advisory extensions. | Unit tests for unknown tools, extension attempts, wrong Task/action/arguments, and expired approval. |
| Retry safety | Durable metadata-only call journal. A concurrent duplicate shares one call; a later duplicate checks the record or a read-only reconciliation callback. Ambiguous writes pause for review. | Unit tests show one invocation under duplicates, zero on crash recovery, and zero when reconciliation finds the earlier result. Production connectors currently have no action-specific external reconciliation callback, so they pause rather than automatically replay. |
| Deadline and cancellation | Connector actions have risk-specific deadlines and abort signals. Discovery has a 15-second deadline. Codex tool items have a 120-second deadline; stopping a Task interrupts and terminates its process group. | Tests cover cancellation before invocation, during dispatch journaling, after dispatch, and timeout. A dispatched external write can remain uncertain after interruption; BMO records that uncertainty. |
| Coding sandbox | Coding uses a detached Git worktree, minimal inherited process environment, and Codex `workspace-write` sandbox. Other Tasks use `read-only`. Later sandbox and permission escalation requests are declined. | Live general Task returned a verified `2+2=4`. Live coding Task wrote only in the isolated worktree, left the source checkout untouched, and returned a verified outcome. |
| Tool visibility | BMO typed chat exposes three dynamic tools; realtime voice exposes four. Connector actions are revealed by owner-anchored discovery per turn. | Injection and discovery-scope tests pass. Codex's own internal tools remain controlled by Codex, so BMO cannot assert a hard per-internal-tool allowlist. |
| Adversarial traces | The durable call journal records queued, aborted-before-dispatch, dispatched, completed, cancelled, timed-out, and reconcile-required states. Task trajectories record approval and verified/unverified outcomes. | Tests assert journal states for duplicate, timeout, cancellation, and crash cases; a denied tool reply for injection; Task ledger state for scoped approval; and trajectory replay for verified/unverified outcomes. An interrupted external effect is explicitly unverified, never reported as completed. |

## Test results

- TypeScript tests: **154/154 passed** (135/135 before this work).
- Python reliability tests: **12/12 passed**.
- Typecheck, production build, and `git diff --check`: passed.
- Five local-safe canaries: **5/5 passed in each of three repetitions**. The two model-backed cases had median **26,763 input tokens** each; approval, cancellation, and discovery cases are local safety checks and do not report model tokens. Raw report: [`outputs/evaluation/tool-safety-live-2026-09-25.json`](../outputs/evaluation/tool-safety-live-2026-09-25.json).
- Schema-size lab: typed chat **3 tools / 1,373 UTF-8 bytes**; voice **4 / 2,214 bytes**. The hypothetical single-code-tool schema is **1 / 256 bytes**, but it is not enabled and these are not token counts.

The live coding smoke used about **227,550 input tokens** and roughly 100 seconds for a simple file write. This is a severe efficiency finding, despite the safety outcome passing. Attempts to disable Codex plugins or narrow its startup skill catalog prevented the coding worker from editing, so that optimization was removed. There is **no matched three-run pre-change live baseline** under the same model, runtime, and configuration; the current 26,763-token canary median cannot be converted into a trustworthy before/after percentage. The TypeScript test count increased by 19; that is coverage, not a performance improvement.

## Reproduce

```bash
npm run typecheck
npm run build
npm test
npm run test:reliability
npm run eval:tool-schemas
npm run eval:canaries -- --live-local-safe --model gpt-6-sol --effort medium --config-id safety-policy-v1 --repeat 3 --json > /tmp/bmo-safety-canaries.json
```

The live canary command spends subscription quota. The saved JSON includes its
runtime, configuration, and evaluation fingerprints for a later matched run.
