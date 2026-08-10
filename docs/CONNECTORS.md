# BMO connected services

BMO exposes connected services to both typed Codex conversation and Codex Realtime Voice through two intent-scoped tools:

1. `discover_services` builds a bounded, allowlisted capability manifest and returns only task-relevant installed capabilities and their exact parameter schemas. Empty or unrelated queries return no catalog.
2. `use_service` validates one discovered action. Reads execute immediately. Writes enter the durable Task runtime and cannot execute before scoped approval.

Connector progress, approval, cancellation, failure and Verified Outcome events use the same authoritative Task state that is injected into the active realtime speech session. Ambient read monitors establish a baseline without speaking a backlog, then inject changed Calendar, Reminders, GitHub, Gmail and Todoist state into an active voice session. Notification-class updates use a fixed, token-free spoken notice. Up to 50 updates observed while voice is disconnected remain queued in memory and are delivered once when the next voice session starts.

The selection/Context Packet/execution-kernel contract is documented in [CAPABILITY-SELECTION.md](./CAPABILITY-SELECTION.md).

## Safety boundary

- No connector registers permanent deletion, purge, erase or empty-trash actions.
- A spoken Stop aborts the active connector process or request and revokes the remaining Task authority.
- External source bodies are returned only to the active conversation. They are not copied into Companion memory.
- Connector logs record service/action/argument names, never argument values or credentials.
- 1Password secret values are resolved inside the connector process and never returned to the model.
- Apple Shortcuts may run only from the `BMO Approved` folder (override with `BMO_SHORTCUTS_FOLDER`) and shortcut names indicating destructive deletion are rejected.
- Connector subprocesses receive `SIGTERM` on Stop or timeout and are force-stopped after two seconds if they do not exit.

## Connection setup

Open **Connections** in the Stage header for live status and setup guidance.

### Apple Calendar, Reminders and Contacts

The first request compiles the small native `BMOAppleBridge` helper and triggers the corresponding macOS privacy prompt. Approve the helper in **System Settings → Privacy & Security**. The helper uses EventKit and Contacts; it does not use Computer Use. Contacts supports search, create and update, but never deletion.

### Apple Notes and Music

The first action may request permission for BMO/osascript to automate Notes or Music.

### Apple Shortcuts

Create a custom Shortcuts folder named `BMO Approved`. Put only reviewed, non-destructive shortcuts in it. BMO cannot run shortcuts outside this folder.

### Google Workspace

`gogcli` is installed. Authenticate the desired personal account:

```bash
gog auth add your-email@gmail.com
gog auth status --json
```

BMO currently exposes Gmail search/read/send, Drive search/upload, Docs read/create, and Sheets read/append. `gog` remains the authenticated source of truth.

### GitHub

GitHub uses the official `gh` CLI:

```bash
gh auth login
gh auth status
```

BMO supports issues, pull requests, comments, creation and notifications. Repository code changes remain Codex Tasks using normal `git`.

### Todoist

For the local personal build, configure either:

```bash
BMO_TODOIST_TOKEN=...
```

or a 1Password reference:

```bash
BMO_TODOIST_TOKEN_REF=op://Personal/Todoist/api-token
```

Todoist uses the current `/api/v1` API. A distributable build should replace the personal token with OAuth.

### Obsidian

Install Obsidian 1.12.7 or newer, enable **Settings → General → Command line interface**, and register the `obsidian` command. Obsidian must be running for the official CLI.

### 1Password

Install `op`, enable 1Password desktop-app integration, and sign in. BMO does not expose a general “read secret” action; only explicit configured `op://` references can be resolved internally.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

The connector contract suite executes all 48 model-visible actions against deterministic fakes and covers discovery, schema validation, direct reads, write approval, Verified Outcomes, cancellation, late-result suppression, proactive queuing/delivery, realtime service calls, secret containment, and the permanent-deletion prohibition. See [CONNECTOR-VERIFICATION.md](./CONNECTOR-VERIFICATION.md) for the requirement-to-evidence matrix. Real account checks remain visible in the Connections panel.
