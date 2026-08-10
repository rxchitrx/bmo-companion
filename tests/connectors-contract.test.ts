import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorGateway } from "../electron/connector-gateway.ts";
import type {
  ConnectorCommandResult,
  ConnectorCommandRunner,
} from "../electron/connector-types.ts";
import { createConnectors } from "../electron/connectors.ts";

class FakeAppleBridge {
  calls: Array<{
    operation: string;
    argumentsObject: Record<string, string | number | boolean>;
  }> = [];

  async call(
    operation: string,
    argumentsObject: Record<string, string | number | boolean>,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) throw new Error("cancelled");
    this.calls.push({ operation, argumentsObject });
    if (operation === "permissions") {
      return {
        calendar: "full_access",
        reminders: "full_access",
        contacts: "authorized",
      };
    }
    return [{ id: `${operation}-id`, title: operation }];
  }
}

class FakeRunner implements ConnectorCommandRunner {
  calls: Array<{
    binary: string;
    args: string[];
    stdin?: string;
  }> = [];

  exists() { return true; }

  async run(
    binary: string,
    args: string[],
    options: {
      signal?: AbortSignal;
      stdin?: string;
      timeoutMs?: number;
      env?: NodeJS.ProcessEnv;
    } = {},
  ): Promise<ConnectorCommandResult> {
    if (options.signal?.aborted) throw new Error("cancelled");
    this.calls.push({ binary, args, stdin: options.stdin });
    let stdout = "";
    if (binary === "shortcuts") {
      if (args.includes("--folders")) stdout = "BMO Approved\n";
      else if (args[0] === "list") stdout = "Safe Workflow\n";
      else stdout = "shortcut complete\n";
    } else if (binary === "osascript") {
      const script = args.join("\n");
      if (script.includes("note.body =")) {
        stdout = JSON.stringify({ id: "note-id", title: "Test Note" });
      } else if (script.includes("Application(\"Notes\")") && script.includes(".find(")) {
        stdout = JSON.stringify({ id: "note-id", title: "Test Note", body: "Body" });
      } else if (script.includes("Application(\"Notes\")")) {
        stdout = JSON.stringify([{ id: "note-id", title: "Test Note", body: "Body" }]);
      } else if (script.includes("make new note")) {
        stdout = "note-id\n";
      } else if (script.includes("current track")) {
        stdout = "playing | Song — Artist\n";
      } else if (script.includes("No matching local-library track")) {
        stdout = "Song — Artist\n";
      }
    } else if (binary === "mdfind") {
      stdout = "/tmp/report.txt\n/tmp/notes.md\n";
    } else if (binary === "gh") {
      if (args.includes("create")) stdout = "https://github.com/example/repo/issues/7\n";
      else stdout = "[]\n";
    } else if (binary === "gog") {
      if (args.includes("status")) {
        stdout = JSON.stringify({
          account: { credentials_exists: true, email: "owner@example.com" },
        });
      } else if (args.includes("upload")) {
        stdout = JSON.stringify({ id: "drive-file-id", name: "report.txt" });
      } else if (args.includes("create") && args.includes("docs")) {
        stdout = JSON.stringify({ id: "doc-id", title: "Plan" });
      } else {
        stdout = JSON.stringify({ results: [{ id: "result-id" }] });
      }
    } else if (binary === "obsidian") {
      stdout = args[0] === "read" ? "# Note\nBody\n" : "Notes/Test.md\n";
    } else if (binary === "op") {
      stdout = "vault-secret\n";
    }
    return { stdout, stderr: "", exitCode: 0 };
  }
}

const samples: Record<string, Record<string, string | number | boolean>> = {
  "calendar.list_calendars": {},
  "calendar.list_events": {
    start: "2026-07-27T00:00:00Z",
    end: "2026-07-28T00:00:00Z",
    limit: 10,
  },
  "calendar.create_event": {
    title: "Planning",
    start: "2026-07-27T10:00:00Z",
    end: "2026-07-27T10:30:00Z",
  },
  "calendar.update_event": { id: "event-id", title: "Updated planning" },
  "reminders.list_reminder_lists": {},
  "reminders.list_reminders": { includeCompleted: false },
  "reminders.create_reminder": { title: "Buy milk", due: "2026-07-28T10:00:00Z" },
  "reminders.update_reminder": { id: "reminder-id", notes: "Organic" },
  "reminders.complete_reminder": { id: "reminder-id" },
  "contacts.search_contacts": { query: "Sam" },
  "contacts.create_contact": {
    givenName: "Sam",
    familyName: "Example",
    email: "sam@example.com",
  },
  "contacts.update_contact": { id: "contact-id", organization: "Example Inc." },
  "notes.search_notes": { query: "project" },
  "notes.read_note": { id: "note-id" },
  "notes.create_note": { title: "Test Note", body: "Body" },
  "notes.append_note": { id: "note-id", content: "More" },
  "shortcuts.list_shortcuts": {},
  "shortcuts.run_shortcut": { name: "Safe Workflow", input: "hello" },
  "music.now_playing": {},
  "music.playpause": {},
  "music.next": {},
  "music.previous": {},
  "music.play_track": { query: "Song" },
  "files.search_files": { query: "report", limit: 10 },
  "google.search_gmail": { query: "is:unread", limit: 10 },
  "google.read_gmail": { messageId: "message-id" },
  "google.send_email": {
    to: "friend@example.com",
    subject: "Hello",
    body: "Checking in",
  },
  "google.search_drive": { query: "report", limit: 10 },
  "google.upload_drive_file": { localPath: "/tmp/report.txt", name: "report.txt" },
  "google.read_doc": { docId: "doc-id" },
  "google.create_doc": { title: "Plan", content: "Initial content" },
  "google.read_sheet": { spreadsheetId: "sheet-id", range: "Sheet1!A1:B2" },
  "google.append_sheet": {
    spreadsheetId: "sheet-id",
    range: "Sheet1!A:B",
    valuesJson: JSON.stringify([["one", "two"]]),
  },
  "todoist.list_tasks": { limit: 10 },
  "todoist.create_task": { content: "Test task", priority: 2 },
  "todoist.complete_task": { id: "task-id" },
  "todoist.update_task": { id: "task-id", dueString: "tomorrow" },
  "github.list_issues": { repo: "example/repo", limit: 10 },
  "github.view_issue": { repo: "example/repo", number: 7 },
  "github.list_pull_requests": { repo: "example/repo", limit: 10 },
  "github.view_pull_request": { repo: "example/repo", number: 7 },
  "github.comment_issue": { repo: "example/repo", number: 7, body: "Looks good" },
  "github.create_issue": { repo: "example/repo", title: "Bug", body: "Details" },
  "github.notifications": { all: false, limit: 10 },
  "obsidian.search_notes": { query: "meeting" },
  "obsidian.read_note": { path: "Notes/Test.md" },
  "obsidian.create_note": { path: "Notes/New.md", content: "# New" },
  "obsidian.append_note": { path: "Notes/Test.md", content: "More" },
};

const expectedModes: Record<string, "read" | "write"> = {
  "calendar.list_calendars": "read",
  "calendar.list_events": "read",
  "calendar.create_event": "write",
  "calendar.update_event": "write",
  "reminders.list_reminder_lists": "read",
  "reminders.list_reminders": "read",
  "reminders.create_reminder": "write",
  "reminders.update_reminder": "write",
  "reminders.complete_reminder": "write",
  "contacts.search_contacts": "read",
  "contacts.create_contact": "write",
  "contacts.update_contact": "write",
  "notes.search_notes": "read",
  "notes.read_note": "read",
  "notes.create_note": "write",
  "notes.append_note": "write",
  "shortcuts.list_shortcuts": "read",
  "shortcuts.run_shortcut": "write",
  "music.now_playing": "read",
  "music.playpause": "write",
  "music.next": "write",
  "music.previous": "write",
  "music.play_track": "write",
  "files.search_files": "read",
  "google.search_gmail": "read",
  "google.read_gmail": "read",
  "google.send_email": "write",
  "google.search_drive": "read",
  "google.upload_drive_file": "write",
  "google.read_doc": "read",
  "google.create_doc": "write",
  "google.read_sheet": "read",
  "google.append_sheet": "write",
  "todoist.list_tasks": "read",
  "todoist.create_task": "write",
  "todoist.complete_task": "write",
  "todoist.update_task": "write",
  "github.list_issues": "read",
  "github.view_issue": "read",
  "github.list_pull_requests": "read",
  "github.view_pull_request": "read",
  "github.comment_issue": "write",
  "github.create_issue": "write",
  "github.notifications": "read",
  "obsidian.search_notes": "read",
  "obsidian.read_note": "read",
  "obsidian.create_note": "write",
  "obsidian.append_note": "write",
};

test("every approved connector action has an explicit tested contract and safe mode", async () => {
  const runner = new FakeRunner();
  const apple = new FakeAppleBridge();
  const priorToken = process.env.BMO_TODOIST_TOKEN;
  process.env.BMO_TODOIST_TOKEN = "test-token";
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const responseBody = url.endsWith("/close")
      ? null
      : JSON.stringify(url.endsWith("/tasks") && init?.method === "POST"
        ? { id: "task-id", content: "Test task" }
        : { results: [{ id: "task-id", content: "Test task" }] });
    return new Response(responseBody, {
      status: 200,
      headers: responseBody ? { "content-type": "application/json" } : undefined,
    });
  };
  try {
    const connectors = createConnectors(runner, apple as never);
    const gateway = new ConnectorGateway(connectors);
    const actual = Object.fromEntries(connectors.flatMap((connector) =>
      connector.actions.map((connectorAction) => [
        `${connector.id}.${connectorAction.name}`,
        connectorAction.mode,
      ])));
    assert.deepEqual(actual, expectedModes);
    assert.deepEqual(Object.keys(samples).sort(), Object.keys(expectedModes).sort());
    assert.deepEqual(
      connectors.find((connector) => connector.id === "onepassword")?.actions,
      [],
      "1Password must remain an internal secret broker, not a model-visible vault reader.",
    );

    for (const [key, args] of Object.entries(samples)) {
      const [service, action] = key.split(".");
      const call = gateway.prepare(service, action, args);
      const result = await gateway.execute(call, new AbortController().signal);
      assert.ok(result.summary.trim(), `${key} must return a voice-ready summary`);
      assert.doesNotMatch(result.summary, /test-token|vault-secret/);
    }
  } finally {
    globalThis.fetch = priorFetch;
    if (priorToken == null) delete process.env.BMO_TODOIST_TOKEN;
    else process.env.BMO_TODOIST_TOKEN = priorToken;
  }
});

test("actual connector surface exposes no permanent deletion action", () => {
  const connectors = createConnectors(new FakeRunner(), new FakeAppleBridge() as never);
  const actionNames = connectors.flatMap((connector) =>
    connector.actions.map((connectorAction) => `${connector.id}.${connectorAction.name}`));
  assert.equal(actionNames.length, Object.keys(expectedModes).length);
  assert.equal(actionNames.some((name) => /delete|erase|purge|destroy|wipe|trash|permanent/i.test(name)), false);
});

test("ordinary service words discover every user-facing connector", async () => {
  const gateway = new ConnectorGateway(
    createConnectors(new FakeRunner(), new FakeAppleBridge() as never),
  );
  const queries: Record<string, string> = {
    calendar: "calendar",
    reminders: "reminders",
    contacts: "contacts",
    notes: "notes",
    shortcuts: "shortcuts",
    music: "music",
    files: "files",
    google: "email",
    todoist: "todoist tasks",
    github: "github pull request",
    obsidian: "obsidian vault",
  };
  for (const [service, query] of Object.entries(queries)) {
    const discovered = await gateway.discover(query);
    assert.ok(
      discovered.some((connector) => connector.id === service),
      `${query} must discover ${service}`,
    );
  }
});

test("connector validation rejects ambiguous or oversized consequential input", () => {
  const gateway = new ConnectorGateway(
    createConnectors(new FakeRunner(), new FakeAppleBridge() as never),
  );
  assert.throws(
    () => gateway.prepare("github", "view_issue", { repo: "example/repo" }),
    /number is required/,
  );
  assert.rejects(
    () => gateway.execute(
      gateway.prepare("google", "upload_drive_file", { localPath: "relative.txt" }),
      new AbortController().signal,
    ),
    /localPath must be an absolute path/,
  );
  const sheet = gateway.prepare("google", "append_sheet", {
    spreadsheetId: "sheet-id",
    range: "Sheet1!A:A",
    valuesJson: JSON.stringify({ not: "rows" }),
  });
  assert.rejects(
    () => gateway.execute(sheet, new AbortController().signal),
    /two-dimensional JSON array/,
  );
  assert.rejects(
    () => gateway.execute(
      gateway.prepare("obsidian", "read_note", { path: "../Secrets.md" }),
      new AbortController().signal,
    ),
    /stay inside the active Obsidian vault/,
  );
});

test("1Password resolves only an explicit Todoist reference and never returns the secret", async () => {
  const runner = new FakeRunner();
  const priorDirect = process.env.BMO_TODOIST_TOKEN;
  const priorReference = process.env.BMO_TODOIST_TOKEN_REF;
  delete process.env.BMO_TODOIST_TOKEN;
  process.env.BMO_TODOIST_TOKEN_REF = "op://Personal/Todoist/token";
  const priorFetch = globalThis.fetch;
  let authorization = "";
  globalThis.fetch = async (_input, init) => {
    authorization = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  };
  try {
    const gateway = new ConnectorGateway(
      createConnectors(runner, new FakeAppleBridge() as never),
    );
    const result = await gateway.execute(
      gateway.prepare("todoist", "list_tasks", {}),
      new AbortController().signal,
    );
    assert.equal(authorization, "Bearer vault-secret");
    assert.doesNotMatch(result.summary, /vault-secret/);
    assert.deepEqual(
      runner.calls.filter((call) => call.binary === "op").map((call) => call.args),
      [["read", "op://Personal/Todoist/token"]],
    );
  } finally {
    globalThis.fetch = priorFetch;
    if (priorDirect == null) delete process.env.BMO_TODOIST_TOKEN;
    else process.env.BMO_TODOIST_TOKEN = priorDirect;
    if (priorReference == null) delete process.env.BMO_TODOIST_TOKEN_REF;
    else process.env.BMO_TODOIST_TOKEN_REF = priorReference;
  }
});
