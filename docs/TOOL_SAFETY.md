# BMO tool safety boundary

`electron/tool-policy.ts` is the closed risk registry for connector and Mac-control tools. All 48
model-visible connector actions are listed explicitly. Read actions can run
without owner approval, but only after the latest direct owner request selects
that capability through `discover_services`. Writes create a scoped Task and
require the owner to approve the exact Task, action, and argument digest. Unknown
tools and Codex sandbox/permission escalations are denied by a final guard.
Policy extensions can make decisions stricter but cannot reverse a denial.

`electron/tool-dispatch.ts` enforces a deadline and cancellation for each
connector action. Before dispatching a write it saves a metadata-only record
to `tool-calls.json` in BMO's user-data directory. A repeated call with the
same Task key checks that record and requires read-only reconciliation; it
never repeats a possibly completed write. Timeout, cancellation, and errors
after dispatch are treated as uncertain external state. BMO pauses for an
owner decision rather than calling a write twice. The record contains the
action id, argument hash, status, and timestamp; it contains no arguments or
tool output. `aborted-before-dispatch` is distinct from a dispatched call.

Coding Tasks run in a new detached Git worktree from a clean project root.
The default Pi worker starts only after an exact approved Code Task, with a
minimal process environment and macOS sandbox. Its four visible tools are
classified in `electron/pi-tool-scope.ts`: `bmo_ls` and `bmo_read` are scoped
reads; `bmo_edit` and `bmo_write` are scoped writes under the approved Task.
Pi has no shell, browser, connector, built-in, or project extension tools in
this path. The tool guard denies paths outside the worktree, hidden metadata,
and symlinks. The OS sandbox denies writes outside the worktree, scratch
directory, and Pi's own configuration. Each tool has a 120-second deadline;
Stop or deadline kills the process group. BMO then runs the original tests in
a separate sandbox without outbound network and rejects test or worktree
mutation before reporting a verified outcome. Interrupted attempts pause for
review and never replay automatically.

Other Task kinds still use Codex with its read-only sandbox. Its internal
tools remain under the Codex runtime; BMO declines requests for wider file,
command, MCP, or OS permissions and kills the owned process group on Stop.

The experimental BMO single-code-tool idea is measured only as serialized
schema size by `npm run eval:tool-schemas`. BMO does not register it as a
dynamic tool; its risk-registry entry is denied. Codex may independently use
its own internal code tool for coding tasks.
Schema size is not a token or latency measurement. Enabling generated tool
code would require a separately verified code sandbox and replay contract.

Run `npm test`, `npm run test:reliability`, `npm run typecheck`, and the five
canaries for regression checks. The adversarial tool tests cover malformed
arguments, injection attempts, approval escalation, duplicate writes,
cancelled-before-dispatch, timeout, crash recovery, unapproved Pi tools,
symlink/path escape, and test-time worktree mutation.
