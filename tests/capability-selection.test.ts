import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPABILITY_SELECTION_LIMITS,
  selectCapabilityManifest,
} from "../electron/capability-selection.ts";
import { ConnectorGateway } from "../electron/connector-gateway.ts";
import type { Connector } from "../electron/connector-types.ts";

function connector(
  id: string,
  actions: Array<{ name: string; description: string }>,
  counters: { probes: number; runs: number } = { probes: 0, runs: 0 },
): Connector {
  return {
    id,
    label: id === "google" ? "Google Workspace" : `${id[0].toUpperCase()}${id.slice(1)}`,
    category: "work",
    async probe() {
      counters.probes += 1;
      return { available: true, connected: true, detail: "ready" };
    },
    actions: actions.map((item) => ({
      ...item,
      label: item.name.replaceAll("_", " "),
      mode: item.name.startsWith("create") || item.name.startsWith("send")
        ? "write"
        : "read",
      parameters: [],
      async run() {
        counters.runs += 1;
        return { summary: "ran" };
      },
    })),
  };
}

const fixtures = () => [
  connector("calendar", [
    { name: "list_events", description: "Read events in a date range." },
    { name: "create_event", description: "Create a calendar event." },
  ]),
  connector("google", [
    { name: "search_gmail", description: "Search Gmail messages." },
    { name: "send_email", description: "Send an email through Gmail." },
    { name: "search_drive", description: "Search Google Drive files." },
  ]),
  connector("github", [
    { name: "list_issues", description: "List GitHub issues." },
    { name: "view_pull_request", description: "Read one pull request and its checks." },
  ]),
];

test("task-relevant manifests omit unrelated services and action schemas", () => {
  const manifest = selectCapabilityManifest(fixtures(), {
    task: "check the GitHub pull request reviews and checks",
  });
  assert.deepEqual(manifest.selectedCapabilityIds, ["github.view_pull_request"]);
  assert.deepEqual(manifest.capabilities.map((service) => service.id), ["github"]);
  assert.equal(manifest.authority, "selection-only");
  assert.equal(JSON.stringify(manifest).includes("send_email"), false);
  assert.equal(JSON.stringify(manifest).includes("create_event"), false);
});

test("an exact allowlisted requested capability remains available", () => {
  const manifest = selectCapabilityManifest(fixtures(), {
    task: "prepare for the meeting",
    requestedCapabilityIds: ["calendar.list_events"],
  });
  assert.ok(manifest.selectedCapabilityIds.includes("calendar.list_events"));
  assert.equal(
    manifest.capabilities.find((service) => service.id === "calendar")
      ?.actions.some((action) => action.name === "list_events"),
    true,
  );
});

test("empty, unknown, and non-allowlisted requests do not expose a broad catalog", () => {
  const empty = selectCapabilityManifest(fixtures(), { task: "" });
  const unknown = selectCapabilityManifest(fixtures(), { task: "book a flight" });
  const extra = connector("fixture", [{ name: "dangerous", description: "Do anything." }]);
  const denied = selectCapabilityManifest([...fixtures(), extra], {
    task: "fixture dangerous",
    requestedCapabilityIds: ["fixture.dangerous"],
  });
  assert.deepEqual(empty.selectedCapabilityIds, []);
  assert.deepEqual(unknown.selectedCapabilityIds, []);
  assert.equal(denied.selectedCapabilityIds.includes("fixture.dangerous"), false);
  assert.equal(denied.omitted.notAllowlisted, 1);
});

test("selection is deterministic, bounded, and has no probe or execution side effect", () => {
  const counters = { probes: 0, runs: 0 };
  const calendar = connector("calendar", [
    { name: "list_calendars", description: "List calendars." },
    { name: "list_events", description: "List events." },
    { name: "create_event", description: "Create event." },
    { name: "update_event", description: "Update event." },
  ], counters);
  const request = { task: "calendar event list create update" };
  const first = selectCapabilityManifest([calendar], request);
  const second = selectCapabilityManifest([calendar], request);
  assert.deepEqual(first, second);
  assert.ok(first.selectedCapabilityIds.length <= CAPABILITY_SELECTION_LIMITS.maxActions);
  assert.ok(first.capabilities.length <= CAPABILITY_SELECTION_LIMITS.maxServices);
  const oversized = selectCapabilityManifest([calendar], {
    task: `calendar ${"different-token ".repeat(100)}`,
    requestedCapabilityIds: Array.from(
      { length: 100 },
      () => "calendar.list_events",
    ),
  });
  assert.equal(oversized.request.truncated, true);
  assert.ok(oversized.request.tokenCount <= CAPABILITY_SELECTION_LIMITS.maxRequestTokens);
  assert.deepEqual(counters, { probes: 0, runs: 0 });
});

test("discovery probes only selected services and emits metadata telemetry", async () => {
  const calendarCounters = { probes: 0, runs: 0 };
  const googleCounters = { probes: 0, runs: 0 };
  const gateway = new ConnectorGateway([
    connector("calendar", [
      { name: "list_events", description: "Read calendar events." },
    ], calendarCounters),
    connector("google", [
      { name: "send_email", description: "Send email." },
    ], googleCounters),
  ]);
  const logs: string[] = [];
  const priorLog = console.log;
  console.log = (...values: unknown[]) => logs.push(values.join(" "));
  try {
    const result = await gateway.discover("calendar events private-meeting-name");
    assert.deepEqual(result.map((service) => service.id), ["calendar"]);
  } finally {
    console.log = priorLog;
  }
  assert.deepEqual(calendarCounters, { probes: 1, runs: 0 });
  assert.deepEqual(googleCounters, { probes: 0, runs: 0 });
  assert.ok(logs.some((line) =>
    line.includes('"scope":"connectors.capabilities"') &&
    line.includes('"event":"context.snapshot"')));
  assert.equal(logs.some((line) => line.includes("private-meeting-name")), false);
});
