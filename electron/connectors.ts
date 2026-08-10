import type { AppleBridge } from "./apple-bridge.js";
import { isAbsolute } from "node:path";
import type {
  Connector,
  ConnectorAction,
  ConnectorCall,
  ConnectorCommandRunner,
  ConnectorInvocationResult,
  ConnectorParameter,
} from "./connector-types.js";

const stringParameter = (
  name: string,
  description: string,
  required = false,
): ConnectorParameter => ({ name, description, required, type: "string" });
const booleanParameter = (
  name: string,
  description: string,
): ConnectorParameter => ({ name, description, type: "boolean" });
const numberParameter = (
  name: string,
  description: string,
  required = false,
): ConnectorParameter => ({ name, description, required, type: "number" });

function text(
  value: unknown,
  name: string,
  required = true,
) {
  const result = typeof value === "string" ? value.trim() : "";
  if (required && !result) throw new Error(`${name} is required.`);
  return result;
}

function integerValue(
  value: unknown,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const raw = value == null ? fallback : Number(value);
  if (!Number.isInteger(raw) || raw < minimum || raw > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return raw;
}

function optionalStringArgument(
  args: Record<string, string | number | boolean>,
  name: string,
) {
  return typeof args[name] === "string" ? { [name]: args[name] as string } : {};
}

function vaultPath(value: unknown, name = "path") {
  const result = text(value, name);
  const components = result.replaceAll("\\", "/").split("/");
  if (isAbsolute(result) || components.includes("..")) {
    throw new Error(`${name} must stay inside the active Obsidian vault.`);
  }
  return result;
}

function jsonOutput(stdout: string) {
  const value = stdout.trim();
  if (!value) return null;
  return JSON.parse(value) as unknown;
}

function summarize(label: string, value: unknown) {
  const rendered = typeof value === "string"
    ? value
    : JSON.stringify(value, null, 2);
  return `${label}\n${rendered}`.slice(0, 24_000);
}

function action(
  definition: Omit<ConnectorAction, "run">,
  run: ConnectorAction["run"],
): ConnectorAction {
  return { ...definition, run };
}

function appleConnectors(bridge: AppleBridge): Connector[] {
  const permission = async (name: "calendar" | "reminders" | "contacts") => {
    const values = await bridge.call("permissions", {}) as Record<string, string>;
    return values[name] ?? "unknown";
  };
  const authorized = (value: string) =>
    value === "authorized" || value === "full_access" || value === "limited";
  return [
    {
      id: "calendar",
      label: "Apple Calendar",
      category: "apple",
      setup: "Allow BMOAppleBridge to access Calendars when macOS asks.",
      async probe() {
        const state = await permission("calendar");
        return {
          available: true,
          connected: authorized(state),
          detail: authorized(state)
            ? "Native EventKit calendar access is authorized."
            : `Native EventKit connector is ready; Calendar permission is ${state.replaceAll("_", " ")}.`,
        };
      },
      actions: [
        action({
          name: "list_calendars",
          label: "List calendars",
          description: "List Apple Calendar collections and their account sources.",
          mode: "read",
          parameters: [],
        }, async (_args, context) => {
          const data = await bridge.call("calendar.calendars", {}, context.signal);
          return { summary: summarize("Apple Calendars:", data), data };
        }),
        action({
          name: "list_events",
          label: "List calendar events",
          description: "Read events in an ISO-8601 date range.",
          mode: "read",
          parameters: [
            stringParameter("start", "Inclusive ISO-8601 start date-time.", true),
            stringParameter("end", "Exclusive ISO-8601 end date-time.", true),
            numberParameter("limit", "Maximum events, default 50."),
          ],
        }, async (args, context) => {
          context.progress("Reading Apple Calendar through EventKit.");
          const data = await bridge.call("calendar.list", {
            start: text(args.start, "start"),
            end: text(args.end, "end"),
            limit: integerValue(args.limit, "limit", 50, 1, 200),
          }, context.signal);
          return { summary: summarize("Apple Calendar events:", data), data };
        }),
        action({
          name: "create_event",
          label: "Create calendar event",
          description: "Create an event. This never deletes or replaces another event.",
          mode: "write",
          parameters: [
            stringParameter("title", "Event title.", true),
            stringParameter("start", "ISO-8601 start date-time.", true),
            stringParameter("end", "ISO-8601 end date-time.", true),
            stringParameter("calendar", "Optional Apple Calendar name."),
            stringParameter("location", "Optional location."),
            stringParameter("notes", "Optional notes."),
            booleanParameter("allDay", "Whether this is an all-day event."),
          ],
        }, async (args, context) => {
          context.progress("Creating the approved Apple Calendar event.");
          const data = await bridge.call("calendar.create", {
            title: text(args.title, "title"),
            start: text(args.start, "start"),
            end: text(args.end, "end"),
            calendar: text(args.calendar, "calendar", false),
            location: text(args.location, "location", false),
            notes: text(args.notes, "notes", false),
            allDay: args.allDay === true,
          }, context.signal);
          return { summary: summarize("Created Apple Calendar event:", data), data };
        }),
        action({
          name: "update_event",
          label: "Update calendar event",
          description: "Update one existing event by identifier. Omitted fields remain unchanged.",
          mode: "write",
          parameters: [
            stringParameter("id", "Event identifier from list_events.", true),
            stringParameter("title", "Optional new title."),
            stringParameter("start", "Optional new ISO-8601 start."),
            stringParameter("end", "Optional new ISO-8601 end."),
            stringParameter("location", "Optional new location."),
            stringParameter("notes", "Optional new notes."),
            booleanParameter("allDay", "Optional all-day setting."),
          ],
        }, async (args, context) => {
          context.progress("Updating the approved Apple Calendar event.");
          const data = await bridge.call("calendar.update", {
            id: text(args.id, "id"),
            ...optionalStringArgument(args, "title"),
            ...optionalStringArgument(args, "start"),
            ...optionalStringArgument(args, "end"),
            ...optionalStringArgument(args, "location"),
            ...optionalStringArgument(args, "notes"),
            ...(typeof args.allDay === "boolean" ? { allDay: args.allDay } : {}),
          }, context.signal);
          return { summary: summarize("Updated Apple Calendar event:", data), data };
        }),
      ],
    },
    {
      id: "reminders",
      label: "Apple Reminders",
      category: "apple",
      setup: "Allow BMOAppleBridge to access Reminders when macOS asks.",
      async probe() {
        const state = await permission("reminders");
        return {
          available: true,
          connected: authorized(state),
          detail: authorized(state)
            ? "Native EventKit reminder access is authorized; permanent deletion is not exposed."
            : `Native EventKit connector is ready; Reminders permission is ${state.replaceAll("_", " ")}.`,
        };
      },
      actions: [
        action({
          name: "list_reminder_lists",
          label: "List reminder lists",
          description: "List Apple Reminder lists and their account sources.",
          mode: "read",
          parameters: [],
        }, async (_args, context) => {
          const data = await bridge.call("reminders.lists", {}, context.signal);
          return { summary: summarize("Apple Reminder lists:", data), data };
        }),
        action({
          name: "list_reminders",
          label: "List reminders",
          description: "Read reminders, optionally from one list.",
          mode: "read",
          parameters: [
            stringParameter("list", "Optional reminder list name."),
            booleanParameter("includeCompleted", "Include completed reminders."),
          ],
        }, async (args, context) => {
          context.progress("Reading Apple Reminders through EventKit.");
          const data = await bridge.call("reminders.list", {
            list: text(args.list, "list", false),
            includeCompleted: args.includeCompleted === true,
          }, context.signal);
          return { summary: summarize("Apple Reminders:", data), data };
        }),
        action({
          name: "create_reminder",
          label: "Create reminder",
          description: "Create an Apple Reminder.",
          mode: "write",
          parameters: [
            stringParameter("title", "Reminder title.", true),
            stringParameter("due", "Optional ISO-8601 due date-time."),
            stringParameter("list", "Optional reminder list name."),
            stringParameter("notes", "Optional notes."),
          ],
        }, async (args, context) => {
          context.progress("Creating the approved Apple Reminder.");
          const data = await bridge.call("reminders.create", {
            title: text(args.title, "title"),
            due: text(args.due, "due", false),
            list: text(args.list, "list", false),
            notes: text(args.notes, "notes", false),
          }, context.signal);
          return { summary: summarize("Created Apple Reminder:", data), data };
        }),
        action({
          name: "update_reminder",
          label: "Update reminder",
          description: "Update the title, due date, or notes of one reminder.",
          mode: "write",
          parameters: [
            stringParameter("id", "Reminder identifier.", true),
            stringParameter("title", "Optional new title."),
            stringParameter("due", "Optional new ISO-8601 due date; empty removes due date."),
            stringParameter("notes", "Optional new notes."),
          ],
        }, async (args, context) => {
          context.progress("Updating the approved Apple Reminder.");
          const data = await bridge.call("reminders.update", {
            id: text(args.id, "id"),
            ...optionalStringArgument(args, "title"),
            ...optionalStringArgument(args, "due"),
            ...optionalStringArgument(args, "notes"),
          }, context.signal);
          return { summary: summarize("Updated Apple Reminder:", data), data };
        }),
        action({
          name: "complete_reminder",
          label: "Complete reminder",
          description: "Mark one reminder complete by its identifier.",
          mode: "write",
          parameters: [stringParameter("id", "Reminder identifier from list_reminders.", true)],
        }, async (args, context) => {
          context.progress("Completing the approved Apple Reminder.");
          const data = await bridge.call("reminders.complete", {
            id: text(args.id, "id"),
          }, context.signal);
          return { summary: summarize("Completed Apple Reminder:", data), data };
        }),
      ],
    },
    {
      id: "contacts",
      label: "Apple Contacts",
      category: "apple",
      setup: "Allow BMOAppleBridge to access Contacts when macOS asks.",
      async probe() {
        const state = await permission("contacts");
        return {
          available: true,
          connected: authorized(state),
          detail: authorized(state)
            ? "Native Contacts search, create and additive update access is authorized; deletion is not exposed."
            : `Native Contacts connector is ready; Contacts permission is ${state.replaceAll("_", " ")}.`,
        };
      },
      actions: [
        action({
          name: "search_contacts",
          label: "Search contacts",
          description: "Find contacts by name. Search itself never edits contacts.",
          mode: "read",
          parameters: [stringParameter("query", "Name or organization to find.", true)],
        }, async (args, context) => {
          context.progress("Searching Apple Contacts.");
          const data = await bridge.call("contacts.search", {
            query: text(args.query, "query"),
          }, context.signal);
          return { summary: summarize("Matching contacts:", data), data };
        }),
        action({
          name: "create_contact",
          label: "Create contact",
          description: "Create an Apple Contact. Existing contacts are never replaced or deleted.",
          mode: "write",
          parameters: [
            stringParameter("givenName", "Given name."),
            stringParameter("familyName", "Family name."),
            stringParameter("organization", "Organization name."),
            stringParameter("email", "Optional primary email address."),
            stringParameter("phone", "Optional primary phone number."),
          ],
        }, async (args, context) => {
          if (
            !text(args.givenName, "givenName", false) &&
            !text(args.familyName, "familyName", false) &&
            !text(args.organization, "organization", false)
          ) {
            throw new Error("A given name, family name, or organization is required.");
          }
          context.progress("Creating the approved Apple Contact.");
          const data = await bridge.call("contacts.create", {
            givenName: text(args.givenName, "givenName", false),
            familyName: text(args.familyName, "familyName", false),
            organization: text(args.organization, "organization", false),
            email: text(args.email, "email", false),
            phone: text(args.phone, "phone", false),
          }, context.signal);
          return { summary: summarize("Created Apple Contact:", data), data };
        }),
        action({
          name: "update_contact",
          label: "Update contact",
          description: "Update selected fields on one Apple Contact. This never deletes a contact.",
          mode: "write",
          parameters: [
            stringParameter("id", "Contact identifier from search_contacts.", true),
            stringParameter("givenName", "Optional given name."),
            stringParameter("familyName", "Optional family name."),
            stringParameter("organization", "Optional organization."),
            stringParameter("email", "Optional email to add if it is not already present."),
            stringParameter("phone", "Optional phone number to add if it is not already present."),
          ],
        }, async (args, context) => {
          const changes = {
            ...optionalStringArgument(args, "givenName"),
            ...optionalStringArgument(args, "familyName"),
            ...optionalStringArgument(args, "organization"),
            ...optionalStringArgument(args, "email"),
            ...optionalStringArgument(args, "phone"),
          };
          if (!Object.keys(changes).length) {
            throw new Error("At least one contact field must be updated.");
          }
          context.progress("Updating the approved Apple Contact.");
          const data = await bridge.call("contacts.update", {
            id: text(args.id, "id"),
            ...changes,
          }, context.signal);
          return { summary: summarize("Updated Apple Contact:", data), data };
        }),
      ],
    },
  ];
}

// JSON encoding in AppleScript is fragile, so JavaScript Automation is used for Notes reads.
const NOTES_JXA_SEARCH = String.raw`
function run(argv) {
  const q = String(argv[0] || "").toLowerCase();
  const app = Application("Notes");
  return JSON.stringify(app.notes().map(n => ({
    id: String(n.id()), title: String(n.name()), body: String(n.plaintext())
  })).filter(n => !q || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q)).slice(0, 30));
}`;
const NOTES_JXA_READ = String.raw`
function run(argv) {
  const wanted = String(argv[0]);
  const app = Application("Notes");
  const note = app.notes().find(n => String(n.id()) === wanted);
  if (!note) throw new Error("Note not found.");
  return JSON.stringify({id:String(note.id()), title:String(note.name()), body:String(note.plaintext())});
}`;
const NOTES_JXA_APPEND = String.raw`
function run(argv) {
  const wanted = String(argv[0]);
  const content = String(argv[1]);
  const app = Application("Notes");
  const note = app.notes().find(n => String(n.id()) === wanted);
  if (!note) throw new Error("Note not found.");
  const escaped = content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
  note.body = String(note.body()) + "<div>" + escaped + "</div>";
  return JSON.stringify({id:String(note.id()), title:String(note.name())});
}`;
const NOTES_APPLESCRIPT_CREATE = String.raw`
on run argv
  set noteTitle to item 1 of argv
  set noteBody to item 2 of argv
  tell application "Notes"
    set targetFolder to default folder of default account
    set createdNote to make new note at targetFolder with properties {name:noteTitle, body:noteBody}
    return id of createdNote
  end tell
end run`;

function commandConnectors(runner: ConnectorCommandRunner): Connector[] {
  const notes: Connector = {
    id: "notes",
    label: "Apple Notes",
    category: "apple",
    setup: "Allow BMO or osascript to automate Notes when macOS asks.",
    async probe() {
      return {
        available: runner.exists("osascript"),
        connected: runner.exists("osascript"),
        detail: "Audited Notes automation is available; attachment-rich notes remain read-only.",
      };
    },
    actions: [
      action({
        name: "search_notes",
        label: "Search notes",
        description: "Search Apple Notes titles and plain text.",
        mode: "read",
        parameters: [stringParameter("query", "Text to find.", true)],
      }, async (args, context) => {
        context.progress("Searching Apple Notes.");
        const result = await runner.run("osascript", [
          "-l", "JavaScript", "-e", NOTES_JXA_SEARCH, "--", text(args.query, "query"),
        ], { signal: context.signal, timeoutMs: 45_000 });
        const data = jsonOutput(result.stdout);
        return { summary: summarize("Matching Apple Notes:", data), data };
      }),
      action({
        name: "read_note",
        label: "Read note",
        description: "Read one Apple Note using the identifier returned by search_notes.",
        mode: "read",
        parameters: [stringParameter("id", "Apple Note identifier.", true)],
      }, async (args, context) => {
        context.progress("Reading the selected Apple Note.");
        const result = await runner.run("osascript", [
          "-l", "JavaScript", "-e", NOTES_JXA_READ, "--", text(args.id, "id"),
        ], { signal: context.signal, timeoutMs: 45_000 });
        const data = jsonOutput(result.stdout);
        return { summary: summarize("Apple Note:", data), data };
      }),
      action({
        name: "create_note",
        label: "Create note",
        description: "Create a plain-text Apple Note. Existing notes are never overwritten.",
        mode: "write",
        parameters: [
          stringParameter("title", "Note title.", true),
          stringParameter("body", "Note body.", true),
        ],
      }, async (args, context) => {
        context.progress("Creating the approved Apple Note.");
        const result = await runner.run("osascript", [
          "-e", NOTES_APPLESCRIPT_CREATE, "--",
          text(args.title, "title"), text(args.body, "body"),
        ], { signal: context.signal, timeoutMs: 45_000 });
        const id = result.stdout.trim();
        return {
          summary: `Created Apple Note “${text(args.title, "title")}”.`,
          data: { id, title: text(args.title, "title") },
        };
      }),
      action({
        name: "append_note",
        label: "Append to note",
        description: "Append plain text to an existing Apple Note without replacing its current content.",
        mode: "write",
        parameters: [
          stringParameter("id", "Apple Note identifier.", true),
          stringParameter("content", "Text to append.", true),
        ],
      }, async (args, context) => {
        context.progress("Appending to the approved Apple Note.");
        const result = await runner.run("osascript", [
          "-l", "JavaScript", "-e", NOTES_JXA_APPEND, "--",
          text(args.id, "id"), text(args.content, "content"),
        ], { signal: context.signal, timeoutMs: 45_000 });
        const data = jsonOutput(result.stdout);
        return { summary: summarize("Updated Apple Note:", data), data };
      }),
    ],
  };

  const shortcuts: Connector = {
    id: "shortcuts",
    label: "Apple Shortcuts",
    category: "apple",
    setup: "Create or install the desired shortcut in Apple Shortcuts.",
    async probe() {
      const available = runner.exists("shortcuts");
      if (!available) {
        return {
          available: false,
          connected: false,
          detail: "The Apple Shortcuts CLI is unavailable.",
        };
      }
      const folder = process.env.BMO_SHORTCUTS_FOLDER?.trim() || "BMO Approved";
      try {
        const result = await runner.run("shortcuts", ["list", "--folders"], {
          timeoutMs: 10_000,
        });
        const connected = result.stdout.split("\n").some(
          (value) => value.trim().toLowerCase() === folder.toLowerCase(),
        );
        return {
          available: true,
          connected,
          detail: connected
            ? `Only shortcuts in the “${folder}” folder can run.`
            : `Create a “${folder}” folder and place reviewed, non-destructive shortcuts inside it.`,
        };
      } catch {
        return {
          available: true,
          connected: false,
          detail: "Apple Shortcuts could not list its approved folder.",
        };
      }
    },
    actions: [
      action({
        name: "list_shortcuts",
        label: "List shortcuts",
        description: "List only the shortcuts in BMO's reviewed Shortcuts folder.",
        mode: "read",
          parameters: [],
      }, async (args, context) => {
        context.progress("Listing Apple Shortcuts.");
        const folder = process.env.BMO_SHORTCUTS_FOLDER?.trim() || "BMO Approved";
        const result = await runner.run("shortcuts", [
          "list", "--folder-name", folder,
        ], { signal: context.signal });
        return { summary: summarize(`Approved Apple Shortcuts in “${folder}”:`, result.stdout.trim()) };
      }),
      action({
        name: "run_shortcut",
        label: "Run shortcut",
        description: "Run one named Apple Shortcut with optional text input.",
        mode: "write",
        parameters: [
          stringParameter("name", "Exact shortcut name.", true),
          stringParameter("input", "Optional text input passed to the shortcut."),
        ],
      }, async (args, context) => {
        const name = text(args.name, "name");
        if (/(?:delete|erase|purge|destroy|wipe|empty\s+trash)/i.test(name)) {
          throw new Error("BMO prohibits shortcuts whose names indicate destructive deletion.");
        }
        const folder = process.env.BMO_SHORTCUTS_FOLDER?.trim() || "BMO Approved";
        const approved = await runner.run("shortcuts", [
          "list", "--folder-name", folder,
        ], { signal: context.signal });
        if (!approved.stdout.split("\n").some(
          (candidate) => candidate.trim().toLowerCase() === name.toLowerCase(),
        )) {
          throw new Error(`“${name}” is not in the reviewed “${folder}” Shortcuts folder.`);
        }
        context.progress(`Running approved shortcut “${name}”.`);
        const input = text(args.input, "input", false);
        const result = await runner.run("shortcuts", ["run", name], {
          signal: context.signal,
          stdin: input || undefined,
          timeoutMs: 120_000,
        });
        return {
          summary: result.stdout.trim()
            ? summarize(`Shortcut “${name}” finished:`, result.stdout.trim())
            : `Shortcut “${name}” finished successfully.`,
        };
      }),
    ],
  };

  const music: Connector = {
    id: "music",
    label: "Apple Music",
    category: "apple",
    setup: "Allow BMO or osascript to automate Music when macOS asks.",
    async probe() {
      const available = runner.exists("osascript");
      return {
        available,
        connected: available,
        detail: "Playback control is available through an audited Music.app automation adapter.",
      };
    },
    actions: [
      action({
        name: "now_playing",
        label: "Now playing",
        description: "Read Apple Music playback state and current track.",
        mode: "read",
        parameters: [],
      }, async (_args, context) => {
        const script = 'tell application "Music" to return (player state as text) & " | " & name of current track & " — " & artist of current track';
        const result = await runner.run("osascript", ["-e", script], { signal: context.signal });
        return { summary: `Apple Music: ${result.stdout.trim()}` };
      }),
      ...(["playpause", "next", "previous"] as const).map((name) => action({
        name,
        label: name === "playpause" ? "Play or pause" : `${name} track`,
        description: `${name} Apple Music playback.`,
        mode: "write" as const,
        parameters: [],
      }, async (_args, context) => {
        const command = name === "next" ? "next track" : name === "previous" ? "previous track" : "playpause";
        context.progress(`Sending the approved ${name} command to Apple Music.`);
        await runner.run("osascript", ["-e", `tell application "Music" to ${command}`], {
          signal: context.signal,
        });
        return { summary: `Apple Music ${name} command completed.` };
      })),
      action({
        name: "play_track",
        label: "Play matching track",
        description: "Find a track in the local Apple Music library and play the first match.",
        mode: "write",
        parameters: [stringParameter("query", "Song, artist, or album text.", true)],
      }, async (args, context) => {
        const query = text(args.query, "query");
        const script = String.raw`
on run argv
  set queryText to item 1 of argv
  tell application "Music"
    set matches to (every file track of library playlist 1 whose name contains queryText or artist contains queryText or album contains queryText)
    if (count of matches) is 0 then error "No matching local-library track was found."
    play item 1 of matches
    return name of item 1 of matches & " — " & artist of item 1 of matches
  end tell
end run`;
        context.progress(`Finding “${query}” in Apple Music.`);
        const result = await runner.run("osascript", ["-e", script, "--", query], {
          signal: context.signal,
        });
        return { summary: `Playing ${result.stdout.trim()}.` };
      }),
    ],
  };

  const spotlight: Connector = {
    id: "files",
    label: "Files and Spotlight",
    category: "apple",
    async probe() {
      const available = runner.exists("mdfind");
      return {
        available,
        connected: available,
        detail: "Read-only local file discovery is ready through Spotlight metadata.",
      };
    },
    actions: [
      action({
        name: "search_files",
        label: "Search files",
        description: "Search local Spotlight metadata. This never opens, moves, or deletes files.",
        mode: "read",
        parameters: [
          stringParameter("query", "Natural-language Spotlight query.", true),
          numberParameter("limit", "Maximum results, default 30."),
        ],
      }, async (args, context) => {
        context.progress("Searching local files with Spotlight.");
        const result = await runner.run("mdfind", [
          "-interpret", text(args.query, "query"),
        ], { signal: context.signal });
        const limit = integerValue(args.limit, "limit", 30, 1, 100);
        const paths = result.stdout.split("\n").filter(Boolean).slice(0, limit);
        return { summary: summarize("Matching local files:", paths), data: paths };
      }),
    ],
  };
  return [notes, shortcuts, music, spotlight];
}

function githubConnector(runner: ConnectorCommandRunner): Connector {
  const ghJson = async (
    args: string[],
    signal: AbortSignal,
  ) => jsonOutput((await runner.run("gh", args, { signal, timeoutMs: 60_000 })).stdout);
  return {
    id: "github",
    label: "GitHub",
    category: "work",
    setup: "Run `gh auth login` if GitHub reports that it is disconnected.",
    async probe() {
      if (!runner.exists("gh")) return {
        available: false, connected: false, detail: "GitHub CLI is not installed.",
      };
      try {
        await runner.run("gh", ["auth", "status"], { timeoutMs: 10_000 });
        return { available: true, connected: true, detail: "GitHub CLI is authenticated." };
      } catch {
        return { available: true, connected: false, detail: "GitHub CLI needs authentication." };
      }
    },
    actions: [
      action({
        name: "list_issues",
        label: "List issues",
        description: "List GitHub issues from one repository.",
        mode: "read",
        parameters: [
          stringParameter("repo", "Repository as owner/name.", true),
          stringParameter("state", "open, closed, or all."),
          numberParameter("limit", "Maximum results, default 30."),
        ],
      }, async (args, context) => {
        const data = await ghJson([
          "issue", "list", "--repo", text(args.repo, "repo"),
          "--state", text(args.state, "state", false) || "open",
          "--limit", String(integerValue(args.limit, "limit", 30, 1, 100)),
          "--json", "number,title,state,author,labels,url,updatedAt",
        ], context.signal);
        return { summary: summarize("GitHub issues:", data), data };
      }),
      action({
        name: "view_issue",
        label: "View issue",
        description: "Read one GitHub issue and its comments.",
        mode: "read",
        parameters: [
          stringParameter("repo", "Repository as owner/name.", true),
          numberParameter("number", "Issue number.", true),
        ],
      }, async (args, context) => {
        const data = await ghJson([
          "issue", "view", String(integerValue(args.number, "number", 0, 1, 2_147_483_647)),
          "--repo", text(args.repo, "repo"),
          "--json", "number,title,body,state,author,labels,comments,url",
        ], context.signal);
        return { summary: summarize("GitHub issue:", data), data };
      }),
      action({
        name: "list_pull_requests",
        label: "List pull requests",
        description: "List pull requests from one repository.",
        mode: "read",
        parameters: [
          stringParameter("repo", "Repository as owner/name.", true),
          stringParameter("state", "open, closed, or merged."),
          numberParameter("limit", "Maximum results, default 30."),
        ],
      }, async (args, context) => {
        const data = await ghJson([
          "pr", "list", "--repo", text(args.repo, "repo"),
          "--state", text(args.state, "state", false) || "open",
          "--limit", String(integerValue(args.limit, "limit", 30, 1, 100)),
          "--json", "number,title,state,author,isDraft,reviewDecision,statusCheckRollup,url,updatedAt",
        ], context.signal);
        return { summary: summarize("GitHub pull requests:", data), data };
      }),
      action({
        name: "view_pull_request",
        label: "View pull request",
        description: "Read one pull request, reviews, files and checks.",
        mode: "read",
        parameters: [
          stringParameter("repo", "Repository as owner/name.", true),
          numberParameter("number", "Pull request number.", true),
        ],
      }, async (args, context) => {
        const data = await ghJson([
          "pr", "view", String(integerValue(args.number, "number", 0, 1, 2_147_483_647)),
          "--repo", text(args.repo, "repo"),
          "--json", "number,title,body,state,author,files,commits,reviews,reviewDecision,statusCheckRollup,url",
        ], context.signal);
        return { summary: summarize("GitHub pull request:", data), data };
      }),
      action({
        name: "comment_issue",
        label: "Comment on issue or PR",
        description: "Post an exact comment to an issue or pull request.",
        mode: "write",
        parameters: [
          stringParameter("repo", "Repository as owner/name.", true),
          numberParameter("number", "Issue or pull request number.", true),
          stringParameter("body", "Exact comment body.", true),
        ],
      }, async (args, context) => {
        context.progress("Posting the approved GitHub comment.");
        await runner.run("gh", [
          "issue", "comment", String(integerValue(args.number, "number", 0, 1, 2_147_483_647)),
          "--repo", text(args.repo, "repo"),
          "--body", text(args.body, "body"),
        ], { signal: context.signal, timeoutMs: 60_000 });
        return { summary: `Posted the approved comment to ${text(args.repo, "repo")}#${integerValue(args.number, "number", 0, 1, 2_147_483_647)}.` };
      }),
      action({
        name: "create_issue",
        label: "Create issue",
        description: "Create a GitHub issue.",
        mode: "write",
        parameters: [
          stringParameter("repo", "Repository as owner/name.", true),
          stringParameter("title", "Issue title.", true),
          stringParameter("body", "Issue body.", true),
        ],
      }, async (args, context) => {
        context.progress("Creating the approved GitHub issue.");
        const result = await runner.run("gh", [
          "issue", "create", "--repo", text(args.repo, "repo"),
          "--title", text(args.title, "title"),
          "--body", text(args.body, "body"),
        ], { signal: context.signal, timeoutMs: 60_000 });
        const url = result.stdout.trim();
        return {
          summary: `Created GitHub issue: ${url}`,
          artifacts: url ? [{ label: text(args.title, "title"), sourceName: "GitHub", sourceUrl: url }] : undefined,
        };
      }),
      action({
        name: "notifications",
        label: "Read GitHub notifications",
        description: "Read recent GitHub notifications for proactive BMO updates.",
        mode: "read",
        parameters: [
          booleanParameter("all", "Include already-read notifications."),
          numberParameter("limit", "Maximum notifications, default 30."),
        ],
      }, async (args, context) => {
        const all = args.all === true;
        const limit = integerValue(args.limit, "limit", 30, 1, 100);
        const data = await ghJson([
          "api", "--method", "GET", "notifications",
          "-f", `all=${all}`,
          "-f", `per_page=${limit}`,
          "--jq", "[.[] | {id,reason,updated_at,repository:.repository.full_name,subject:.subject}]",
        ], context.signal);
        return { summary: summarize("GitHub notifications:", data), data };
      }),
    ],
  };
}

function googleConnector(runner: ConnectorCommandRunner): Connector {
  const gog = async (args: string[], signal: AbortSignal) => {
    const result = await runner.run("gog", [
      "--json", "--results-only", "--no-input", ...args,
    ], { signal, timeoutMs: 120_000 });
    return jsonOutput(result.stdout) ?? result.stdout.trim();
  };
  return {
    id: "google",
    label: "Google Workspace",
    category: "work",
    setup: "Run `gog auth add your-email@gmail.com` and approve the required Google scopes.",
    async probe() {
      if (!runner.exists("gog")) return {
        available: false, connected: false, detail: "gogcli is not installed.",
      };
      try {
        const result = await runner.run("gog", ["auth", "status", "--json"], { timeoutMs: 10_000 });
        const status = jsonOutput(result.stdout) as any;
        const connected = status?.account?.credentials_exists === true || !!status?.account?.email;
        return {
          available: true,
          connected,
          detail: connected ? `gogcli is authenticated${status.account.email ? ` as ${status.account.email}` : ""}.` : "gogcli is installed but not authenticated.",
        };
      } catch (error) {
        return { available: true, connected: false, detail: error instanceof Error ? error.message : "gogcli status failed." };
      }
    },
    actions: [
      action({
        name: "search_gmail",
        label: "Search Gmail",
        description: "Search Gmail using Gmail query syntax.",
        mode: "read",
        parameters: [
          stringParameter("query", "Gmail query, such as `is:unread newer_than:7d`.", true),
          numberParameter("limit", "Maximum threads, default 20."),
        ],
      }, async (args, context) => {
        const data = await gog([
          "gmail", "search", text(args.query, "query"),
          "--max", String(integerValue(args.limit, "limit", 20, 1, 100)),
        ], context.signal);
        return { summary: summarize("Gmail search results:", data), data };
      }),
      action({
        name: "read_gmail",
        label: "Read Gmail message",
        description: "Read one Gmail message by identifier.",
        mode: "read",
        parameters: [stringParameter("messageId", "Gmail message identifier.", true)],
      }, async (args, context) => {
        const data = await gog([
          "gmail", "get", text(args.messageId, "messageId"),
        ], context.signal);
        return { summary: summarize("Gmail message:", data), data };
      }),
      action({
        name: "send_email",
        label: "Send email",
        description: "Send an email through the connected Gmail account.",
        mode: "write",
        parameters: [
          stringParameter("to", "Exact recipient email address.", true),
          stringParameter("subject", "Exact subject.", true),
          stringParameter("body", "Exact message body.", true),
          stringParameter("cc", "Optional CC recipients."),
        ],
      }, async (args, context) => {
        context.progress("Sending the approved Gmail message.");
        await gog([
          "gmail", "send",
          "--to", text(args.to, "to"),
          "--subject", text(args.subject, "subject"),
          "--body", text(args.body, "body"),
          ...(text(args.cc, "cc", false) ? ["--cc", text(args.cc, "cc", false)] : []),
        ], context.signal);
        return { summary: `Sent the approved email to ${text(args.to, "to")} with subject “${text(args.subject, "subject")}”.` };
      }),
      action({
        name: "search_drive",
        label: "Search Google Drive",
        description: "Search Google Drive files.",
        mode: "read",
        parameters: [
          stringParameter("query", "Drive full-text search.", true),
          numberParameter("limit", "Maximum files, default 30."),
        ],
      }, async (args, context) => {
        const data = await gog([
          "drive", "search", text(args.query, "query"),
          "--max", String(integerValue(args.limit, "limit", 30, 1, 100)),
        ], context.signal);
        return { summary: summarize("Google Drive results:", data), data };
      }),
      action({
        name: "upload_drive_file",
        label: "Upload Drive file",
        description: "Upload one existing local file to Google Drive.",
        mode: "write",
        parameters: [
          stringParameter("localPath", "Absolute path of the local file.", true),
          stringParameter("name", "Optional Drive filename."),
          stringParameter("parentId", "Optional Drive parent folder identifier."),
        ],
      }, async (args, context) => {
        const localPath = text(args.localPath, "localPath");
        if (!isAbsolute(localPath)) {
          throw new Error("localPath must be an absolute path so the approval identifies one exact file.");
        }
        context.progress("Uploading the approved file to Google Drive.");
        const data = await gog([
          "drive", "upload", localPath,
          ...(text(args.name, "name", false) ? ["--name", text(args.name, "name", false)] : []),
          ...(text(args.parentId, "parentId", false) ? ["--parent", text(args.parentId, "parentId", false)] : []),
        ], context.signal) as any;
        const id = String(data?.id ?? "");
        return {
          summary: summarize("Uploaded Google Drive file:", data),
          data,
          artifacts: id ? [{
            label: text(args.name, "name", false) || localPath,
            sourceName: "Google Drive",
            sourceUrl: `https://drive.google.com/open?id=${id}`,
          }] : undefined,
        };
      }),
      action({
        name: "read_doc",
        label: "Read Google Doc",
        description: "Read a Google Doc as plain text.",
        mode: "read",
        parameters: [stringParameter("docId", "Google Doc identifier.", true)],
      }, async (args, context) => {
        const data = await gog(["docs", "cat", text(args.docId, "docId")], context.signal);
        return { summary: summarize("Google Doc:", data), data };
      }),
      action({
        name: "create_doc",
        label: "Create Google Doc",
        description: "Create a new Google Doc, optionally with initial content.",
        mode: "write",
        parameters: [
          stringParameter("title", "Document title.", true),
          stringParameter("content", "Optional initial content."),
        ],
      }, async (args, context) => {
        context.progress("Creating the approved Google Doc.");
        const data = await gog(["docs", "create", text(args.title, "title")], context.signal) as any;
        const id = String(data?.id ?? data?.documentId ?? "");
        const content = text(args.content, "content", false);
        if (content && id) {
          context.progress("Writing the approved initial document content.");
          await gog(["docs", "write", id, content], context.signal);
        }
        const url = id ? `https://docs.google.com/document/d/${id}/edit` : undefined;
        return {
          summary: summarize("Created Google Doc:", data),
          data,
          artifacts: url ? [{ label: text(args.title, "title"), sourceName: "Google Docs", sourceUrl: url }] : undefined,
        };
      }),
      action({
        name: "read_sheet",
        label: "Read Google Sheet range",
        description: "Read values from a Google Sheet range.",
        mode: "read",
        parameters: [
          stringParameter("spreadsheetId", "Spreadsheet identifier.", true),
          stringParameter("range", "A1 range such as Sheet1!A1:D20.", true),
        ],
      }, async (args, context) => {
        const data = await gog([
          "sheets", "get", text(args.spreadsheetId, "spreadsheetId"),
          text(args.range, "range"),
        ], context.signal);
        return { summary: summarize("Google Sheet values:", data), data };
      }),
      action({
        name: "append_sheet",
        label: "Append Google Sheet row",
        description: "Append rows to a Google Sheet. valuesJson must be a JSON array of rows.",
        mode: "write",
        parameters: [
          stringParameter("spreadsheetId", "Spreadsheet identifier.", true),
          stringParameter("range", "Target A1 range.", true),
          stringParameter("valuesJson", "JSON array of row arrays.", true),
        ],
      }, async (args, context) => {
        const values = text(args.valuesJson, "valuesJson");
        const rows = JSON.parse(values) as unknown;
        if (!Array.isArray(rows) || rows.some((row) => !Array.isArray(row))) {
          throw new Error("valuesJson must be a two-dimensional JSON array with at most 1,000 rows and 10,000 cells.");
        }
        const rowArrays = rows as unknown[][];
        if (
          rowArrays.some((row) => row.some((cell: unknown) =>
            cell !== null &&
            typeof cell !== "string" &&
            typeof cell !== "number" &&
            typeof cell !== "boolean")) ||
          rowArrays.length > 1_000 ||
          rowArrays.reduce((count, row) => count + row.length, 0) > 10_000
        ) {
          throw new Error("valuesJson must be a two-dimensional JSON array with at most 1,000 rows and 10,000 cells.");
        }
        context.progress("Appending the approved Google Sheet rows.");
        const data = await gog([
          "sheets", "append", text(args.spreadsheetId, "spreadsheetId"),
          text(args.range, "range"), "--values-json", values,
        ], context.signal);
        return { summary: summarize("Appended Google Sheet rows:", data), data };
      }),
    ],
  };
}

function obsidianConnector(runner: ConnectorCommandRunner): Connector {
  const run = async (args: string[], signal: AbortSignal) =>
    (await runner.run("obsidian", args, { signal, timeoutMs: 60_000 })).stdout.trim();
  return {
    id: "obsidian",
    label: "Obsidian",
    category: "knowledge",
    setup: "Install Obsidian 1.12.7 or newer, enable Settings → General → Command line interface, then register the `obsidian` CLI.",
    async probe() {
      const available = runner.exists("obsidian");
      return {
        available,
        connected: available,
        detail: available ? "Official Obsidian CLI is available." : "Official Obsidian CLI is not registered.",
      };
    },
    actions: [
      action({
        name: "search_notes",
        label: "Search Obsidian",
        description: "Search the active Obsidian vault.",
        mode: "read",
        parameters: [stringParameter("query", "Obsidian search query.", true)],
      }, async (args, context) => ({
        summary: summarize("Obsidian search results:", await run([
          "search", `query=${text(args.query, "query")}`,
        ], context.signal)),
      })),
      action({
        name: "read_note",
        label: "Read Obsidian note",
        description: "Read one note by vault-relative path.",
        mode: "read",
        parameters: [stringParameter("path", "Vault-relative note path.", true)],
      }, async (args, context) => ({
        summary: summarize("Obsidian note:", await run([
          "read", `path=${vaultPath(args.path)}`,
        ], context.signal)),
      })),
      action({
        name: "create_note",
        label: "Create Obsidian note",
        description: "Create a new Markdown note. Existing files are not overwritten.",
        mode: "write",
        parameters: [
          stringParameter("path", "Vault-relative new note path.", true),
          stringParameter("content", "Initial Markdown content.", true),
        ],
      }, async (args, context) => {
        context.progress("Creating the approved Obsidian note.");
        await run([
          "create",
          `path=${vaultPath(args.path)}`,
          `content=${text(args.content, "content")}`,
        ], context.signal);
        return { summary: `Created Obsidian note ${vaultPath(args.path)}.` };
      }),
      action({
        name: "append_note",
        label: "Append to Obsidian note",
        description: "Append Markdown to an existing note.",
        mode: "write",
        parameters: [
          stringParameter("path", "Vault-relative note path.", true),
          stringParameter("content", "Markdown to append.", true),
        ],
      }, async (args, context) => {
        context.progress("Appending to the approved Obsidian note.");
        await run([
          "append",
          `path=${vaultPath(args.path)}`,
          `content=${text(args.content, "content")}`,
        ], context.signal);
        return { summary: `Updated Obsidian note ${vaultPath(args.path)}.` };
      }),
    ],
  };
}

async function todoistToken(runner: ConnectorCommandRunner, signal?: AbortSignal) {
  const direct = process.env.BMO_TODOIST_TOKEN?.trim();
  if (direct && !direct.startsWith("op://")) return direct;
  const reference = direct || process.env.BMO_TODOIST_TOKEN_REF?.trim();
  if (!reference?.startsWith("op://")) return "";
  if (!runner.exists("op")) throw new Error("1Password CLI is required to resolve the Todoist secret reference.");
  const result = await runner.run("op", ["read", reference], { signal, timeoutMs: 20_000 });
  return result.stdout.trim();
}

function todoistConnector(runner: ConnectorCommandRunner): Connector {
  const request = async (
    path: string,
    init: RequestInit,
    signal: AbortSignal,
  ) => {
    const token = await todoistToken(runner, signal);
    if (!token) throw new Error("Todoist is not connected. Set BMO_TODOIST_TOKEN or BMO_TODOIST_TOKEN_REF.");
    const response = await fetch(`https://api.todoist.com/api/v1${path}`, {
      ...init,
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Todoist ${response.status}: ${body.slice(0, 2_000)}`);
    return body ? JSON.parse(body) as unknown : null;
  };
  return {
    id: "todoist",
    label: "Todoist",
    category: "work",
    setup: "Set BMO_TODOIST_TOKEN to a personal token, or BMO_TODOIST_TOKEN_REF to an `op://` 1Password reference.",
    async probe() {
      const configured = !!process.env.BMO_TODOIST_TOKEN || !!process.env.BMO_TODOIST_TOKEN_REF;
      return {
        available: true,
        connected: configured,
        detail: configured ? "Todoist credential reference is configured." : "Todoist needs a credential reference.",
      };
    },
    actions: [
      action({
        name: "list_tasks",
        label: "List Todoist tasks",
        description: "Read active Todoist tasks, optionally filtered.",
        mode: "read",
        parameters: [
          stringParameter("projectId", "Optional Todoist project identifier."),
          stringParameter("label", "Optional label."),
          numberParameter("limit", "Maximum tasks, default 50."),
        ],
      }, async (args, context) => {
        const query = new URLSearchParams();
        const projectId = text(args.projectId, "projectId", false);
        const label = text(args.label, "label", false);
        if (projectId) query.set("project_id", projectId);
        if (label) query.set("label", label);
        query.set("limit", String(integerValue(args.limit, "limit", 50, 1, 200)));
        const data = await request(`/tasks?${query}`, { method: "GET" }, context.signal);
        return { summary: summarize("Todoist tasks:", data), data };
      }),
      action({
        name: "create_task",
        label: "Create Todoist task",
        description: "Create a Todoist task.",
        mode: "write",
        parameters: [
          stringParameter("content", "Task content.", true),
          stringParameter("description", "Optional task description."),
          stringParameter("dueString", "Natural-language due date, such as tomorrow at 4pm."),
          stringParameter("projectId", "Optional project identifier."),
          numberParameter("priority", "Priority from 1 to 4."),
        ],
      }, async (args, context) => {
        context.progress("Creating the approved Todoist task.");
        const body: Record<string, unknown> = { content: text(args.content, "content") };
        const description = text(args.description, "description", false);
        const dueString = text(args.dueString, "dueString", false);
        const projectId = text(args.projectId, "projectId", false);
        if (description) body.description = description;
        if (dueString) body.due_string = dueString;
        if (projectId) body.project_id = projectId;
        if (args.priority != null) {
          body.priority = integerValue(args.priority, "priority", 1, 1, 4);
        }
        const data = await request("/tasks", {
          method: "POST", body: JSON.stringify(body),
        }, context.signal) as any;
        return {
          summary: summarize("Created Todoist task:", data),
          data,
          artifacts: data?.id ? [{
            label: text(args.content, "content"),
            sourceName: "Todoist",
            sourceUrl: `https://app.todoist.com/app/task/${data.id}`,
          }] : undefined,
        };
      }),
      action({
        name: "complete_task",
        label: "Complete Todoist task",
        description: "Mark one Todoist task complete.",
        mode: "write",
        parameters: [stringParameter("id", "Todoist task identifier.", true)],
      }, async (args, context) => {
        context.progress("Completing the approved Todoist task.");
        await request(`/tasks/${encodeURIComponent(text(args.id, "id"))}/close`, {
          method: "POST",
        }, context.signal);
        return { summary: `Completed Todoist task ${text(args.id, "id")}.` };
      }),
      action({
        name: "update_task",
        label: "Update Todoist task",
        description: "Update task content, description, due date, or priority.",
        mode: "write",
        parameters: [
          stringParameter("id", "Todoist task identifier.", true),
          stringParameter("content", "Optional new task content."),
          stringParameter("description", "Optional new description."),
          stringParameter("dueString", "Optional natural-language due date."),
          numberParameter("priority", "Optional priority from 1 to 4."),
        ],
      }, async (args, context) => {
        const id = text(args.id, "id");
        const body: Record<string, unknown> = {};
        if (typeof args.content === "string") body.content = args.content;
        if (typeof args.description === "string") body.description = args.description;
        if (typeof args.dueString === "string") body.due_string = args.dueString;
        if (typeof args.priority === "number") {
          body.priority = integerValue(args.priority, "priority", 1, 1, 4);
        }
        if (!Object.keys(body).length) throw new Error("At least one Todoist field must be updated.");
        context.progress("Updating the approved Todoist task.");
        const data = await request(`/tasks/${encodeURIComponent(id)}`, {
          method: "POST", body: JSON.stringify(body),
        }, context.signal);
        return { summary: summarize("Updated Todoist task:", data), data };
      }),
    ],
  };
}

function onePasswordConnector(runner: ConnectorCommandRunner): Connector {
  return {
    id: "onepassword",
    label: "1Password",
    category: "security",
    setup: "Install 1Password CLI, enable desktop-app integration, and sign in. BMO only resolves configured `op://` references internally.",
    async probe() {
      if (!runner.exists("op")) return {
        available: false, connected: false, detail: "1Password CLI is not installed.",
      };
      try {
        await runner.run("op", ["account", "list"], { timeoutMs: 10_000 });
        return { available: true, connected: true, detail: "1Password CLI is available as BMO’s secret broker." };
      } catch {
        return { available: true, connected: false, detail: "1Password CLI needs sign-in or desktop integration." };
      }
    },
    actions: [],
  };
}

export function createConnectors(
  runner: ConnectorCommandRunner,
  bridge: AppleBridge,
): Connector[] {
  return [
    ...appleConnectors(bridge),
    ...commandConnectors(runner),
    googleConnector(runner),
    todoistConnector(runner),
    githubConnector(runner),
    obsidianConnector(runner),
    onePasswordConnector(runner),
  ];
}

export function connectorCallGoal(call: ConnectorCall) {
  return `${call.label}: ${call.action}`;
}
