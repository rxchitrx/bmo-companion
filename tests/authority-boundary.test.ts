import assert from "node:assert/strict";
import test from "node:test";
import {
  createTaskThreadParams,
  normalizeAccountUsage,
  normalizeTaskTokenUsage,
  taskServerRequestReply,
} from "../electron/codex-adapter.ts";
import { createConversationOnlyThreadParams } from "../electron/conversation-client.ts";
import { createCompanionConversationThreadParams } from "../electron/conversation-client.ts";
import {
  CodexRealtimeVoiceClient,
  createRealtimeConversationThreadParams,
  isOwnerStopTranscript,
  taskSnapshotToRealtimeContext,
  taskStatusSpeech,
} from "../electron/realtime-voice-client.ts";
import type { TaskSnapshot } from "../electron/task-runtime.ts";
import { ConnectorGateway } from "../electron/connector-gateway.ts";
import { ConnectorToolBridge } from "../electron/connector-tools.ts";
import type { Connector } from "../electron/connector-types.ts";

test("revoked Task authority cancels every consequential server request", () => {
  assert.deepEqual(
    taskServerRequestReply(
      "item/commandExecution/requestApproval",
      {},
      false,
    ),
    { result: { decision: "cancel" } },
  );
  assert.deepEqual(
    taskServerRequestReply(
      "item/fileChange/requestApproval",
      {},
      false,
    ),
    { result: { decision: "cancel" } },
  );
  assert.deepEqual(
    taskServerRequestReply(
      "mcpServer/elicitation/request",
      { _meta: { codex_approval_kind: "mcp_tool_call" } },
      false,
    ),
    { result: { action: "decline", content: null } },
  );
});

test("Codex task token usage uses the protocol total snapshot", () => {
  assert.deepEqual(
    normalizeTaskTokenUsage({
      last: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 2,
        totalTokens: 15,
      },
      total: {
        inputTokens: 4000,
        cachedInputTokens: 2500,
        outputTokens: 750,
        reasoningOutputTokens: 300,
        totalTokens: 4750,
      },
    }),
    {
      inputTokens: 4000,
      cachedInputTokens: 2500,
      outputTokens: 750,
      reasoningOutputTokens: 300,
      totalTokens: 4750,
    },
  );
});

test("task workers do not preload unrelated connector or environment context", () => {
  const policy = createTaskThreadParams("/tmp/bmo-test");
  assert.deepEqual(policy.environments, []);
  assert.deepEqual(policy.selectedCapabilityRoots, []);
  assert.equal(policy.config.apps._default.enabled, false);
});

test("subscription usage snapshots expose percentages without account secrets", () => {
  assert.deepEqual(
    normalizeAccountUsage({
      planType: "plus",
      primary: { usedPercent: 23, resetsAt: 1785150000 },
      secondary: { usedPercent: 41, resetsAt: 1785700000 },
    }),
    {
      planType: "plus",
      primaryUsedPercent: 23,
      primaryResetsAt: 1785150000,
      secondaryUsedPercent: 41,
      secondaryResetsAt: 1785700000,
    },
  );
});

test("realtime voice controls the computer through the Task runtime and can read authoritative state", () => {
  const policy = createRealtimeConversationThreadParams("/tmp/bmo-test");
  assert.equal(policy.approvalPolicy, "never");
  assert.equal(policy.sandbox, "read-only");
  assert.deepEqual(policy.environments, []);
  assert.deepEqual(policy.selectedCapabilityRoots, []);
  assert.equal(policy.config.apps._default.enabled, false);
  assert.deepEqual(
    policy.dynamicTools.map((tool) => tool.name),
    ["control_computer", "discover_services", "use_service", "get_task_state"],
  );
});

test("typed conversation has no execution capabilities", () => {
  const policy = createConversationOnlyThreadParams("/tmp/bmo-test");
  assert.equal(policy.approvalPolicy, "never");
  assert.equal(policy.sandbox, "read-only");
  assert.deepEqual(policy.environments, []);
  assert.deepEqual(policy.selectedCapabilityRoots, []);
  assert.deepEqual(policy.dynamicTools, []);
  assert.equal(policy.config.apps._default.enabled, false);
});

test("typed companion conversation exposes only task state and validated connector tools", () => {
  const policy = createCompanionConversationThreadParams("/tmp/bmo-test");
  assert.equal(policy.approvalPolicy, "never");
  assert.equal(policy.sandbox, "read-only");
  assert.deepEqual(
    policy.dynamicTools.map((tool) => tool.name),
    ["get_task_state", "discover_services", "use_service"],
  );
});

test("owner Stop phrases are recognized as a Task boundary", () => {
  for (const phrase of [
    "stop",
    "BMO, stop",
    "cancel everything",
    "stop the current task",
    "Stop what you're doing now",
    "Please abort everything",
  ]) {
    assert.equal(isOwnerStopTranscript(phrase), true, phrase);
  }
  assert.equal(isOwnerStopTranscript("stop by the store later"), false);
});

test("authoritative Task context reports approval and the latest known outcome", () => {
  const task: TaskSnapshot = {
    id: "task-1",
    goal: "Open Brave",
    status: "running",
    state: "working",
    progress: ["Task created.", "Browser worker started."],
    approvalExpiresAt: "2026-07-27T12:00:00.000Z",
  };
  const context = taskSnapshotToRealtimeContext(task);
  assert.match(context, /Status: running/);
  assert.match(context, /Approval: granted/);
  assert.match(context, /Latest progress: Browser worker started/);
  assert.equal(
    taskStatusSpeech(task, "waiting_approval"),
    "Approved. I’ve started the task.",
  );
});

test("owner Stop cancels only the active Task and keeps realtime voice connected", async () => {
  let cancellationCount = 0;
  let processStopCount = 0;
  const updates: Array<{ status: string }> = [];
  const client = new CodexRealtimeVoiceClient(
    async () => { throw new Error("not used"); },
    async () => {
      cancellationCount += 1;
      return true;
    },
  );
  Object.assign(client as unknown as Record<string, unknown>, {
    connection: {
      running: true,
      request: async () => ({}),
      stop: () => { processStopCount += 1; },
    },
    threadId: "thread-1",
    sessionId: "session-1",
    emit: (update: { status: string }) => updates.push(update),
  });

  (client as unknown as { enforceOwnerStop(sessionId: string): void })
    .enforceOwnerStop("session-1");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(cancellationCount, 1);
  assert.equal(processStopCount, 0);
  assert.equal(client.active, true);
  assert.equal(updates.at(-1)?.status, "connected");
});

test("approval transition is injected into voice context and spoken once", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = new CodexRealtimeVoiceClient();
  Object.assign(client as unknown as Record<string, unknown>, {
    connection: {
      running: true,
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return {};
      },
      stop: () => {},
    },
    threadId: "thread-1",
    sessionId: "session-1",
  });
  const waiting: TaskSnapshot = {
    id: "task-1",
    goal: "Open Brave",
    status: "waiting_approval",
    state: "approval",
    progress: ["Waiting for approval."],
  };
  const running: TaskSnapshot = {
    ...waiting,
    status: "running",
    state: "thinking",
    approvalExpiresAt: "2026-07-27T12:00:00.000Z",
    progress: [...waiting.progress, "Approved for this Task."],
  };

  await client.syncTask(waiting);
  await client.syncTask(running);

  assert.deepEqual(
    calls.map((call) => call.method),
    [
      "thread/realtime/appendText",
      "thread/realtime/appendText",
      "thread/realtime/appendSpeech",
    ],
  );
  assert.equal(calls.at(-1)?.params.text, "Approved. I’ve started the task.");
});

test("realtime voice suppresses a matching recent Task unless retry is explicit", async () => {
  const prior: TaskSnapshot = {
    id: "prior-task",
    goal: "Open Safari",
    status: "failed",
    state: "error",
    progress: ["Computer Use stopped."],
    summary: "UNVERIFIED: the Mac may already have changed.",
    createdAt: new Date().toISOString(),
  };
  let starts = 0;
  const client = new CodexRealtimeVoiceClient(
    async () => {
      starts += 1;
      throw new Error("must not start");
    },
    async () => false,
    () => prior,
  );

  const reply = await (
    client as unknown as {
      handleServerRequest(message: Record<string, unknown>): Promise<{
        result?: { contentItems?: Array<{ text?: string }> };
      }>;
    }
  ).handleServerRequest({
    method: "item/tool/call",
    params: {
      tool: "control_computer",
      arguments: { goal: "Open Safari", kind: "computer", retry: false },
    },
  });

  assert.equal(starts, 0);
  assert.match(reply.result?.contentItems?.[0]?.text ?? "", /matching Task just finished/);
});

test("an explicit realtime retry passes the authoritative prior Task to the new worker", async () => {
  const prior: TaskSnapshot = {
    id: "prior-task",
    goal: "Open Safari",
    status: "needs_decision",
    state: "approval",
    progress: ["Reconciliation needs a decision."],
    summary: "RECONCILIATION: Safari may already be open.",
    createdAt: new Date().toISOString(),
  };
  let receivedPrior: TaskSnapshot | undefined;
  const client = new CodexRealtimeVoiceClient(
    async (goal, kind, retryOf) => {
      receivedPrior = retryOf;
      return {
        id: "retry-task",
        goal,
        status: "waiting_approval",
        state: "approval",
        progress: ["Waiting for approval."],
        kind,
        retryOf: retryOf?.id,
      };
    },
    async () => false,
    () => prior,
  );

  await (
    client as unknown as {
      handleServerRequest(message: Record<string, unknown>): Promise<unknown>;
    }
  ).handleServerRequest({
    method: "item/tool/call",
    params: {
      tool: "control_computer",
      arguments: { goal: "Open Safari", kind: "computer", retry: true },
    },
  });

  assert.equal(receivedPrior?.id, prior.id);
});

test("realtime voice can discover, read, and request approval for connected services", async () => {
  const connector: Connector = {
    id: "fixture",
    label: "Fixture",
    category: "work",
    async probe() {
      return { available: true, connected: true, detail: "ready" };
    },
    actions: [
      {
        name: "read",
        label: "Read",
        description: "Read fixture data.",
        mode: "read",
        parameters: [{ name: "query", type: "string", description: "query", required: true }],
        async run(args) { return { summary: `found ${args.query}` }; },
      },
      {
        name: "write",
        label: "Write",
        description: "Write fixture data.",
        mode: "write",
        parameters: [{ name: "value", type: "string", description: "value", required: true }],
        async run() { return { summary: "written" }; },
      },
    ],
  };
  const gateway = new ConnectorGateway([connector]);
  let requestedTask: TaskSnapshot | null = null;
  const tools = new ConnectorToolBridge({
    gateway,
    async startTask(call) {
      requestedTask = {
        id: "connector-task",
        goal: `${call.label}: ${call.action}`,
        kind: "connector",
        connectorCall: call,
        status: "waiting_approval",
        state: "approval",
        progress: ["Waiting for approval."],
      };
      return requestedTask;
    },
    readCurrentTask: () => requestedTask,
  });
  const client = new CodexRealtimeVoiceClient(
    async () => { throw new Error("Computer Use must not run."); },
    async () => false,
    () => requestedTask,
    tools,
  );
  const request = (tool: string, args: Record<string, unknown>) =>
    (client as unknown as {
      handleServerRequest(message: Record<string, unknown>): Promise<{
        result?: { success?: boolean; contentItems?: Array<{ text?: string }> };
      }>;
    }).handleServerRequest({
      method: "item/tool/call",
      params: { tool, arguments: args },
    });

  const discovered = await request("discover_services", { query: "fixture read" });
  assert.match(discovered.result?.contentItems?.[0]?.text ?? "", /fixture/);
  const read = await request("use_service", {
    service: "fixture",
    action: "read",
    arguments_json: JSON.stringify({ query: "hello" }),
  });
  assert.match(read.result?.contentItems?.[0]?.text ?? "", /found hello/);
  const write = await request("use_service", {
    service: "fixture",
    action: "write",
    arguments_json: JSON.stringify({ value: "hello" }),
  });
  assert.equal(requestedTask?.status, "waiting_approval");
  assert.match(write.result?.contentItems?.[0]?.text ?? "", /waiting_approval/);
});

test("proactive connector changes are injected as untrusted context into live voice", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = new CodexRealtimeVoiceClient();
  Object.assign(client as unknown as Record<string, unknown>, {
    connection: {
      running: true,
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return {};
      },
      stop: () => {},
    },
    threadId: "thread-1",
    sessionId: "session-1",
  });
  await client.syncConnectorSignal({
    id: "github.notifications:abc",
    service: "github",
    action: "notifications",
    observedAt: "2026-07-27T10:00:00.000Z",
    summary: "A new review was requested.",
    notify: true,
  });
  assert.deepEqual(
    calls.map((call) => call.method),
    ["thread/realtime/appendText", "thread/realtime/appendSpeech"],
  );
  assert.match(String(calls[0].params.text), /UNTRUSTED EXTERNAL DATA/);
  assert.match(String(calls[0].params.text), /new review was requested/);
  assert.match(String(calls[1].params.text), /new update in GitHub/);
});

test("spoken Stop aborts an in-flight realtime connector read and keeps voice alive", async () => {
  let readAborted = false;
  let taskStopChecks = 0;
  const connector: Connector = {
    id: "fixture",
    label: "Fixture",
    category: "work",
    async probe() {
      return { available: true, connected: true, detail: "ready" };
    },
    actions: [{
      name: "read",
      label: "Read",
      description: "Slow read.",
      mode: "read",
      parameters: [],
      async run(_args, context) {
        return new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => {
            readAborted = true;
            reject(new Error("Connector action was cancelled."));
          }, { once: true });
        });
      },
    }],
  };
  const tools = new ConnectorToolBridge({
    gateway: new ConnectorGateway([connector]),
    async startTask() { throw new Error("not used"); },
    readCurrentTask: () => null,
  });
  const updates: Array<{ status: string }> = [];
  const client = new CodexRealtimeVoiceClient(
    async () => { throw new Error("not used"); },
    async () => {
      taskStopChecks += 1;
      return false;
    },
    () => null,
    tools,
  );
  Object.assign(client as unknown as Record<string, unknown>, {
    connection: {
      running: true,
      request: async () => ({}),
      stop: () => {},
    },
    threadId: "thread-1",
    sessionId: "session-1",
    emit: (update: { status: string }) => updates.push(update),
  });
  const pending = (client as unknown as {
    handleServerRequest(message: Record<string, unknown>): Promise<{
      result?: { contentItems?: Array<{ text?: string }> };
    }>;
  }).handleServerRequest({
    method: "item/tool/call",
    params: {
      tool: "use_service",
      arguments: {
        service: "fixture",
        action: "read",
        arguments_json: "{}",
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  (client as unknown as { enforceOwnerStop(sessionId: string): void })
    .enforceOwnerStop("session-1");
  const reply = await pending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readAborted, true);
  assert.equal(taskStopChecks, 1);
  assert.match(reply.result?.contentItems?.[0]?.text ?? "", /cancelled/);
  assert.equal(client.active, true);
  assert.equal(updates.at(-1)?.status, "connected");
});
