import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BmoInteractionRouter, explicitRouteFor, handleDirectTypedRequest, type InteractionRouterOptions } from "../electron/interaction-router.ts";
import type { TaskSnapshot } from "../electron/task-runtime.ts";
import { ConnectorGateway } from "../electron/connector-gateway.ts";
import { ConnectorToolBridge } from "../electron/connector-tools.ts";
import type { Connector } from "../electron/connector-types.ts";
import { CodexRealtimeVoiceClient } from "../electron/realtime-voice-client.ts";

async function fixture(t: TestContext, overrides: Partial<InteractionRouterOptions> = {}) {
  const base = await mkdtemp(join(tmpdir(), "bmo-interaction-router-"));
  let current: TaskSnapshot | null = null;
  let starts = 0;
  let stops = 0;
  const project = { id: "saved-1", name: "BMO", aliases: ["companion"], root: "/tmp/bmo", verification: "npm-test" as const };
  const options: InteractionRouterOptions = {
    path: join(base, "session.json"),
    readTask: () => current,
    startTask: async (goal, kind, retryOf) => {
      starts++;
      current = { id: `task-${starts}`, goal, kind, status: "waiting_approval", state: "approval", progress: [], retryOf: retryOf?.id,
        project: kind === "coding" ? { ...project, baseCommit: "base" } : undefined };
      return current;
    },
    stopTask: async () => { stops++; return true; },
    listProjects: async () => ({ projects: [project], activeId: project.id }),
    selectProject: async (query) => {
      if (query !== "companion" && query !== project.id) throw new Error("Unknown saved project.");
      return project;
    },
    ...overrides,
  };
  const router = new BmoInteractionRouter(options);
  await router.load();
  t.after(async () => { await router.flush(); await rm(base, { recursive: true, force: true }); });
  return { router, options, project, setTask: (task: TaskSnapshot | null) => { current = task; }, starts: () => starts, stops: () => stops };
}

test("shared session survives restart, stays bounded, and never restores tool authority", async (t) => {
  const { router, options } = await fixture(t);
  router.beginTurn("voice", "Please switch to BMO");
  router.recordAssistant("voice", "BMO is selected.");
  for (let index = 0; index < 20; index++) router.recordAssistant("typed", `Reply ${index}`);
  await router.flush();
  assert.equal((await stat(options.path)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(options.path, "utf8"));
  assert.equal(saved.entries.length, 12);
  const restarted = new BmoInteractionRouter(options);
  await restarted.load();
  assert.match(await restarted.sharedContext("voice"), /Reply 19/);
  assert.match(await restarted.sharedContext("typed"), /Active project: BMO/);
  assert.equal((await restarted.authorize("voice", "project")).allowed, false);
});

test("invalid saved session is preserved for diagnosis and starts without restored authority", async (t) => {
  const { router, options } = await fixture(t);
  await writeFile(options.path, "{invalid", { mode: 0o600 });
  await router.load();
  const files = await readdir(join(options.path, ".."));
  assert.ok(files.some((name) => name.startsWith("session.json.invalid-")));
  assert.equal((await router.authorize("voice", "coding")).allowed, false);
});

test("one current owner turn governs both input modes and stale model calls fail closed", async (t) => {
  let resolveRoute!: (value: { route: "coding"; confidence: number; source: "laya" }) => void;
  const pending = new Promise<{ route: "coding"; confidence: number; source: "laya" }>((resolve) => { resolveRoute = resolve; });
  const { router } = await fixture(t, { laya: { route: async () => pending } });
  router.beginTurn("voice", "Fix the parser");
  const stale = router.authorize("voice", "coding");
  router.beginTurn("typed", "Hello");
  resolveRoute({ route: "coding", confidence: 0.99, source: "laya" });
  assert.equal((await stale).allowed, false);
  assert.equal((await router.authorize("voice", "coding")).allowed, false);
  router.endChannel("typed");
  assert.equal((await router.authorize("typed", "coding")).allowed, false);
});

test("a route result arriving after turn expiry cannot authorize a tool", async (t) => {
  let clock = 0;
  let resolveRoute!: (value: null) => void;
  const pending = new Promise<null>((resolve) => { resolveRoute = resolve; });
  const { router } = await fixture(t, { now: () => clock, laya: { route: async () => pending } });
  router.beginTurn("voice", "Fix the parser");
  const authorization = router.authorize("voice", "coding");
  clock = 120_001;
  resolveRoute(null);
  assert.equal((await authorization).allowed, false);
});

test("high confidence local disagreement asks for clarification; absent or weak Laya cannot grant authority", async (t) => {
  const { router, starts } = await fixture(t, { laya: { route: async () => ({ route: "conversation", confidence: 0.95, source: "laya" }) } });
  router.beginTurn("voice", "Explain what a worktree is");
  await assert.rejects(router.createTask("voice", "Explain what a worktree is", "coding"), /clarify/);
  assert.equal(starts(), 0);
  const low = await fixture(t, { laya: { route: async () => ({ route: "conversation", confidence: 0.4, source: "laya" }) } });
  assert.equal((await low.router.authorize("voice", "coding")).allowed, false);
  low.router.beginTurn("voice", "Fix the parser");
  assert.equal((await low.router.authorize("voice", "coding")).allowed, true);
});

test("explicit owner requests select narrow routes before any model proposal", async (t) => {
  assert.equal(explicitRouteFor("Switch to the BMO project"), "project");
  assert.equal(explicitRouteFor("What's on my calendar tomorrow?"), "connector");
  assert.equal(explicitRouteFor("Fix the login bug in my project"), "coding");
  assert.equal(explicitRouteFor("Open this website in the browser"), "browser");
  assert.equal(explicitRouteFor("Open Finder on my Mac"), "computer");
  assert.equal(explicitRouteFor("Explain how Git works"), "conversation");
  assert.equal(explicitRouteFor("Please handle this"), null);
  const { router, starts } = await fixture(t);
  router.beginTurn("voice", "Fix the login bug in my project");
  await assert.rejects(router.createTask("voice", "Fix the login bug in my project", "computer"), /clarify/);
  assert.equal(starts(), 0);
});

test("all Task routes use one scoped creation path with duplicate and retry controls", async (t) => {
  const { router, starts, setTask } = await fixture(t);
  router.beginTurn("voice", "Fix the parser");
  const first = await router.createTask("voice", "Fix the parser", "coding", false, "companion");
  assert.equal(first.status, "waiting_approval");
  assert.equal((await router.createTask("voice", "Fix the parser", "coding")).id, first.id);
  assert.equal(starts(), 1);
  await assert.rejects(router.createTask("voice", "Open Safari", "computer"), /clarify/);
  setTask({ ...first, status: "failed", state: "error", finishedAt: new Date().toISOString() });
  assert.equal((await router.createTask("voice", "Fix the parser", "coding")).id, first.id);
  const retry = await router.createTask("voice", "Fix the parser", "coding", true);
  assert.equal(retry.retryOf, first.id);
  assert.equal(starts(), 2);
});

test("concurrent Task calls create only one approval and a project switch prevents stale reuse", async (t) => {
  let current: TaskSnapshot | null = null;
  let starts = 0;
  let activeId = "saved-1";
  const firstProject = { id: "saved-1", name: "BMO", aliases: [], root: "/tmp/bmo", verification: "npm-test" as const };
  const secondProject = { id: "saved-2", name: "Other", aliases: [], root: "/tmp/other", verification: "npm-test" as const };
  const { router } = await fixture(t, {
    readTask: () => current,
    listProjects: async () => ({ projects: [firstProject, secondProject], activeId }),
    startTask: async (goal, kind) => {
      starts++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      current = { id: `task-${starts}`, goal, kind, status: "waiting_approval", state: "approval", progress: [],
        project: { ...firstProject, baseCommit: "base" } };
      return current;
    },
  });
  router.beginTurn("voice", "Fix the parser in this project");
  const [one, two] = await Promise.all([
    router.createTask("voice", "Fix the parser in this project", "coding"),
    router.createTask("voice", "Fix the parser in this project", "coding"),
  ]);
  assert.equal(one.id, two.id);
  assert.equal(starts, 1);
  current = { ...one, status: "completed", state: "done", finishedAt: new Date().toISOString() };
  activeId = "saved-2";
  const next = await router.createTask("voice", "Fix the parser in this project", "coding");
  assert.notEqual(next.id, one.id);
  assert.equal(starts, 2);
});

test("the typed Task control is an explicit owner choice even when words sound conversational", async (t) => {
  const { router, starts } = await fixture(t, { laya: { route: async () => ({ route: "conversation", confidence: 0.99, source: "laya" }) } });
  router.beginTurn("typed", "Explain this project in a Task", "general");
  const task = await router.createTask("typed", "Explain this project in a Task", "general");
  assert.equal(task.kind, "general");
  assert.equal(starts(), 1);
});

test("project switching and stop use the shared turn boundary", async (t) => {
  const { router, project, stops, setTask } = await fixture(t);
  router.beginTurn("voice", "Switch to companion project");
  assert.equal((await router.selectProject("voice", "companion")).id, project.id);
  setTask({ id: "active", goal: "work", status: "running", state: "working", progress: [] });
  await assert.rejects(router.selectProject("voice", "companion"), /Finish or cancel/);
  assert.equal(await router.stop("voice"), true);
  assert.equal(stops(), 1);
  assert.equal((await router.authorize("voice", "project")).allowed, false);
});

test("a voice project switch accepts a saved name and refuses a different name", async (t) => {
  const project = { id: "saved-1", name: "BMO", aliases: ["companion"], root: "/tmp/bmo", verification: "npm-test" as const };
  const other = { id: "saved-2", name: "Other", aliases: [], root: "/tmp/other", verification: "npm-test" as const };
  let selections = 0;
  const { router } = await fixture(t, {
    listProjects: async () => ({ projects: [project, other], activeId: project.id }),
    selectProject: async (query) => { selections++; return query === other.id ? other : project; },
  });
  router.beginTurn("voice", "Switch to BMO");
  assert.equal((await router.selectProject("voice", project.id)).id, project.id);
  await assert.rejects(router.selectProject("voice", other.id), /did not name/);
  assert.equal(selections, 1);
});

test("connector schemas and actions require the current owner turn", async (t) => {
  let reads = 0;
  const connector: Connector = {
    id: "fixture", label: "Fixture", category: "work", actions: [{
      name: "read", label: "Read", description: "Read fixture", mode: "read", parameters: [],
      async run() { reads++; return { summary: "One event" }; },
    }],
    async probe() { return { available: true, connected: true, detail: "ready" }; },
  };
  const { router } = await fixture(t, { laya: { route: async () => ({ route: "connector", confidence: 0.9, source: "laya" }) } });
  const tools = new ConnectorToolBridge({
    gateway: new ConnectorGateway([connector], new Set(["fixture.read"])),
    startTask: async () => { throw new Error("No write expected"); },
    readCurrentTask: () => null,
    authorize: () => router.authorize("voice", "connector"),
  });
  const call = (tool: string, args: object) => tools.handle({ method: "item/tool/call", params: { tool, arguments: args } });
  assert.equal((await call("discover_services", { query: "fixture" }) as any).result.success, false);
  router.beginTurn("voice", "Read fixture data from the connected service");
  tools.beginOwnerTurn("Read fixture data from the connected service");
  const catalog = await call("discover_services", { query: "fixture" });
  assert.equal((catalog as any).result.success, true);
  await call("use_service", { service: "fixture", action: "read", arguments_json: "{}" });
  assert.equal(reads, 1);
  router.beginTurn("typed", "Hello");
  const stale = await call("use_service", { service: "fixture", action: "read", arguments_json: "{}" });
  assert.equal((stale as any).result.success, false);
  assert.equal(reads, 1);
});

test("a connector write waiting for authorization cannot cross into the next owner turn", async (t) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let authorizationCalls = 0;
  let tasks = 0;
  const connector: Connector = {
    id: "fixture", label: "Fixture", category: "work", actions: [{
      name: "write", label: "Write", description: "Write fixture", mode: "write", parameters: [],
      async run() { throw new Error("A write must remain behind approval."); },
    }],
    async probe() { return { available: true, connected: true, detail: "ready" }; },
  };
  const { router } = await fixture(t);
  const tools = new ConnectorToolBridge({
    gateway: new ConnectorGateway([connector], new Set(["fixture.write"])),
    startTask: async () => { tasks++; throw new Error("Stale write reached Task creation."); },
    readCurrentTask: () => null,
    authorize: async () => {
      authorizationCalls++;
      if (authorizationCalls === 2) await pending;
      return { allowed: true, reason: "test" };
    },
  });
  router.beginTurn("voice", "Write to connected service");
  tools.beginOwnerTurn("Write to connected service");
  const call = (tool: string, args: object) => tools.handle({ method: "item/tool/call", params: { tool, arguments: args } });
  assert.equal((await call("discover_services", { query: "fixture" }) as any).result.success, true);
  const stale = call("use_service", { service: "fixture", action: "write", arguments_json: "{}" });
  router.beginTurn("typed", "Hello");
  tools.beginOwnerTurn("Hello");
  release();
  assert.equal((await stale as any).result.success, false);
  assert.equal(tasks, 0);
});

test("production voice tool dispatch uses BMO's router rather than its legacy callback", async (t) => {
  const { router, starts } = await fixture(t);
  const voice = new CodexRealtimeVoiceClient(
    async () => { throw new Error("Legacy voice callback must not run."); },
    async () => false,
    () => null,
    undefined, undefined, undefined, undefined,
    router,
  );
  const call = () => (voice as unknown as { handleServerRequest(message: object): Promise<any> }).handleServerRequest({
    method: "item/tool/call", params: { tool: "control_computer", arguments: { goal: "Fix the parser bug", kind: "coding", retry: false } },
  });
  router.beginTurn("voice", "Fix the parser bug");
  assert.equal((await call()).result.success, true);
  assert.equal(starts(), 1);
  router.beginTurn("typed", "Hello");
  assert.equal((await call()).result.success, false);
  assert.equal(starts(), 1);
});

test("an active voice session receives completed typed context without speech or authority", async (t) => {
  const { router } = await fixture(t);
  const voice = new CodexRealtimeVoiceClient(async () => { throw new Error("unused"); }, async () => false, () => null,
    undefined, undefined, undefined, undefined, router);
  router.beginTurn("typed", "What changed in my project?");
  router.recordAssistant("typed", "The parser was updated.");
  router.endChannel("typed");
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  (voice as any).threadId = "voice-thread";
  (voice as any).connection = { running: true, request: async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
  } };
  assert.equal(await voice.syncSharedTypedContext(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "thread/realtime/appendText");
  assert.match(String(calls[0]?.params.text), /The parser was updated/);
  assert.equal((await router.authorize("voice", "coding")).allowed, false);
});

test("typed fallback routes explicit project, Task, and Stop requests without a model turn", async (t) => {
  const { router, starts, stops } = await fixture(t);
  assert.equal(await handleDirectTypedRequest(router, "Hello BMO"), null);
  assert.match(await handleDirectTypedRequest(router, "Switch to the companion project") ?? "", /Active project: BMO/);
  assert.equal(starts(), 0);
  assert.match(await handleDirectTypedRequest(router, "Fix the parser bug in my project") ?? "", /waiting approval/);
  assert.equal(starts(), 1);
  assert.equal(await handleDirectTypedRequest(router, "Stop", true), "Stopped the current Task.");
  assert.equal(stops(), 1);
  assert.equal((await router.authorize("typed", "coding")).allowed, false);
});

test("typed project names must match one saved project", async (t) => {
  const { router, starts } = await fixture(t);
  assert.match(await handleDirectTypedRequest(router, "Switch to the unknown project") ?? "", /could not match a saved project/);
  assert.equal(starts(), 0);
});
