import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorGateway, ConnectorRoutingTaskExecutor } from "../electron/connector-gateway.ts";
import { ConnectorToolBridge } from "../electron/connector-tools.ts";
import type { Connector } from "../electron/connector-types.ts";
import { TaskRuntime, type ActivityLedger, type TaskExecutor } from "../electron/task-runtime.ts";
import {
  ConnectorEventMonitor,
  defaultConnectorWatches,
} from "../electron/connector-events.ts";

class Ledger implements ActivityLedger {
  events: Record<string, unknown>[] = [];
  async append(event: Record<string, unknown>) { this.events.push(event); }
}

function fixture(onWrite?: (signal: AbortSignal) => Promise<void>): Connector {
  return {
    id: "fixture",
    label: "Fixture",
    category: "work",
    async probe() {
      return { available: true, connected: true, detail: "ready" };
    },
    actions: [
      {
        name: "read",
        label: "Read fixture",
        description: "Read a value.",
        mode: "read",
        parameters: [{ name: "query", type: "string", description: "query", required: true }],
        async run(args) {
          return { summary: `found ${args.query}` };
        },
      },
      {
        name: "write",
        label: "Write fixture",
        description: "Write a value.",
        mode: "write",
        parameters: [{ name: "value", type: "string", description: "value", required: true }],
        async run(args, context) {
          context.progress("writing");
          await onWrite?.(context.signal);
          return { summary: `wrote ${args.value}` };
        },
      },
    ],
  };
}

function toolCall(tool: string, args: Record<string, unknown>) {
  return {
    method: "item/tool/call",
    params: { tool, arguments: args },
  };
}

test("connector discovery is intent-scoped and reports setup state", async () => {
  const gateway = new ConnectorGateway([fixture()]);
  const result = await gateway.discover("read");
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].actions.map((action) => action.name), ["read"]);
  assert.equal(result[0].connected, true);
});

test("connector arguments reject unknown types and missing required values", () => {
  const gateway = new ConnectorGateway([fixture()]);
  assert.throws(() => gateway.prepare("fixture", "read", {}), /query is required/);
  assert.throws(() => gateway.prepare("fixture", "read", { query: 7 }), /query must be a string/);
  assert.deepEqual(
    gateway.prepare("fixture", "read", { query: "hello", ignored: "nope" }).arguments,
    { query: "hello" },
  );
});

test("service reads return directly without creating an approved Task", async () => {
  const gateway = new ConnectorGateway([fixture()]);
  let starts = 0;
  const bridge = new ConnectorToolBridge({
    gateway,
    async startTask() {
      starts += 1;
      throw new Error("must not start");
    },
    readCurrentTask: () => null,
  });
  const reply = await bridge.handle(toolCall("use_service", {
    service: "fixture",
    action: "read",
    arguments_json: JSON.stringify({ query: "hello" }),
  }));
  assert.equal(starts, 0);
  assert.match(JSON.stringify(reply), /found hello/);
});

test("an active connector read is abortable by spoken Stop", async () => {
  let observedAbort = false;
  const connector = fixture();
  connector.actions[0].run = async (_args, context) =>
    new Promise((resolve, reject) => {
      context.signal.addEventListener("abort", () => {
        observedAbort = true;
        reject(new Error("Connector action was cancelled."));
      }, { once: true });
    });
  const bridge = new ConnectorToolBridge({
    gateway: new ConnectorGateway([connector]),
    async startTask() { throw new Error("not used"); },
    readCurrentTask: () => null,
  });
  const pending = bridge.handle(toolCall("use_service", {
    service: "fixture",
    action: "read",
    arguments_json: JSON.stringify({ query: "hello" }),
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bridge.cancelActiveReads(), 1);
  const reply = await pending;
  assert.equal(observedAbort, true);
  assert.match(JSON.stringify(reply), /cancelled/);
});

test("service writes wait for scoped approval and then report a Verified Outcome", async () => {
  const gateway = new ConnectorGateway([fixture()]);
  const ledger = new Ledger();
  const fallback: TaskExecutor = {
    async execute() { throw new Error("Codex fallback must not run."); },
  };
  const updates: string[] = [];
  const runtime = new TaskRuntime(
    new ConnectorRoutingTaskExecutor(gateway, fallback),
    ledger,
    (task) => updates.push(task.status),
  );
  const bridge = new ConnectorToolBridge({
    gateway,
    startTask: (call) => runtime.create("Fixture write", {
      kind: "connector",
      connectorCall: call,
    }),
    readCurrentTask: () => runtime.currentTask(),
  });

  const reply = await bridge.handle(toolCall("use_service", {
    service: "fixture",
    action: "write",
    arguments_json: JSON.stringify({ value: "hello" }),
  }));
  assert.match(JSON.stringify(reply), /waiting_approval/);
  assert.equal(runtime.currentTask()?.status, "waiting_approval");
  assert.equal(ledger.events.some((event) => event.type === "task.completed"), false);

  await runtime.approve(runtime.currentTask()!.id);
  assert.equal(runtime.currentTask()?.status, "completed");
  assert.equal(runtime.currentTask()?.summary, "wrote hello");
  assert.ok(updates.includes("running"));
  assert.ok(updates.includes("completed"));
  assert.ok(ledger.events.some((event) => event.type === "task.completed" && event.verified === true));
});

test("Stop revokes a running connector write and late completion cannot win", async () => {
  let released = false;
  const gateway = new ConnectorGateway([fixture(async (signal) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { released = true; resolve(); }, 100);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      }, { once: true });
    });
  })]);
  const runtime = new TaskRuntime(
    new ConnectorRoutingTaskExecutor(gateway, {
      async execute() { throw new Error("not used"); },
    }),
    new Ledger(),
    () => {},
  );
  const call = gateway.prepare("fixture", "write", { value: "danger" });
  const task = await runtime.create("Fixture write", {
    kind: "connector",
    connectorCall: call,
  });
  const approval = runtime.approve(task.id);
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.cancel(task.id);
  await approval;
  assert.equal(runtime.currentTask()?.status, "cancelled");
  assert.equal(released, false);
});

test("the connector surface contains no permanent deletion capability", async () => {
  const gateway = new ConnectorGateway([fixture()]);
  const statuses = await gateway.statuses();
  const names = statuses.flatMap((connector) => connector.actions.map((action) => action.name));
  assert.equal(names.some((name) => /delete|permanent|purge|erase/i.test(name)), false);
});

test("ambient connector polling establishes a baseline and emits only real changes", async () => {
  let value = "first";
  const connector = fixture();
  connector.actions[0].run = async () => ({ summary: value });
  const gateway = new ConnectorGateway([connector]);
  const ledger = new Ledger();
  const signals: string[] = [];
  const monitor = new ConnectorEventMonitor(
    gateway,
    [{
      id: "fixture.watch",
      service: "fixture",
      action: "read",
      arguments: () => ({ query: "status" }),
    }],
    (signal) => {
      signals.push(signal.summary);
      return true;
    },
    ledger,
  );
  await monitor.pollOnce();
  await monitor.pollOnce();
  assert.deepEqual(signals, []);
  value = "second";
  await monitor.pollOnce();
  assert.deepEqual(signals, ["second"]);
  assert.ok(ledger.events.some((event) => event.type === "connector.signal"));
});

test("proactive watches cover the approved update sources without model polling", () => {
  assert.deepEqual(
    defaultConnectorWatches().map((watch) => [
      watch.service,
      watch.action,
      watch.notify === true,
    ]),
    [
      ["calendar", "list_events", true],
      ["reminders", "list_reminders", true],
      ["github", "notifications", true],
      ["google", "search_gmail", true],
      ["todoist", "list_tasks", false],
    ],
  );
});

test("updates observed without live voice are queued and flushed once", async () => {
  let value = "baseline";
  const connector = fixture();
  connector.actions[0].run = async () => ({ summary: value });
  const monitor = new ConnectorEventMonitor(
    new ConnectorGateway([connector]),
    [{
      id: "fixture.pending",
      service: "fixture",
      action: "read",
      notify: true,
      arguments: () => ({ query: "status" }),
    }],
    () => false,
    new Ledger(),
  );
  await monitor.pollOnce();
  value = "changed";
  await monitor.pollOnce();
  assert.equal(monitor.pendingCount(), 1);
  const delivered: string[] = [];
  await monitor.flushPending(async (signal) => {
    delivered.push(signal.summary);
    return true;
  });
  assert.deepEqual(delivered, ["changed"]);
  assert.equal(monitor.pendingCount(), 0);
  await monitor.flushPending(async () => true);
  assert.deepEqual(delivered, ["changed"]);
});
