import assert from "node:assert/strict";
import test from "node:test";
import {
  createTaskThreadParams,
  normalizeAccountUsage,
  normalizeTaskTokenUsage,
  taskServerRequestReply,
} from "../electron/codex-adapter.ts";
import { createConversationOnlyThreadParams } from "../electron/conversation-client.ts";
import {
  CodexRealtimeVoiceClient,
  createRealtimeConversationThreadParams,
  isOwnerStopTranscript,
  taskSnapshotToRealtimeContext,
  taskStatusSpeech,
} from "../electron/realtime-voice-client.ts";
import type { TaskSnapshot } from "../electron/task-runtime.ts";

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
    ["control_computer", "get_task_state"],
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
