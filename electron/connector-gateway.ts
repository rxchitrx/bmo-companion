import type {
  Connector,
  ConnectorAction,
  ConnectorCall,
  ConnectorInvocationResult,
  ConnectorStatus,
} from "./connector-types.js";
import { randomUUID } from "node:crypto";
import type { ExecutionResult, TaskExecutor } from "./task-runtime.js";
import { diagnosticLog } from "./diagnostics.js";
import { recordContextSnapshot } from "./context-telemetry.js";
import { createTaskAuthorityScope, evaluateTaskAuthority } from "./permission-lifecycle.js";
import { evaluateToolAction, exactToolApproval, toolArgumentsHash, type ExactToolApproval, TOOL_RISK_REGISTRY } from "./tool-policy.js";
import { ToolDispatcher } from "./tool-dispatch.js";
import {
  MODEL_VISIBLE_CAPABILITY_ALLOWLIST,
  selectCapabilityManifest,
  type CapabilitySelectionRequest,
} from "./capability-selection.js";

function safeArguments(
  action: ConnectorAction,
  raw: unknown,
): Record<string, string | number | boolean> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Action arguments must be a JSON object.");
  const source = raw as Record<string, unknown>;
  const allowed = new Map(action.parameters.map((parameter) => [parameter.name, parameter]));
  const result: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(source)) {
    const parameter = allowed.get(name);
    if (!parameter) throw new Error(`Unknown argument ${name} for ${action.name}.`);
    if (value == null) throw new Error(`${name} cannot be null.`);
    if (parameter.type === "string" && typeof value === "string" && value.length <= 50_000) result[name] = value;
    else if (parameter.type === "number" && typeof value === "number" && Number.isFinite(value)) result[name] = value;
    else if (parameter.type === "boolean" && typeof value === "boolean") result[name] = value;
    else throw new Error(`${name} must be a ${parameter.type} within the allowed size.`);
  }
  for (const parameter of action.parameters) {
    if (parameter.required && (result[parameter.name] == null || result[parameter.name] === "")) {
      throw new Error(`${parameter.name} is required for ${action.name}.`);
    }
  }
  return result;
}

export class ConnectorGateway {
  private readonly byId: Map<string, Connector>;

  constructor(
    private readonly connectors: Connector[],
    private readonly capabilityAllowlist: ReadonlySet<string> =
      MODEL_VISIBLE_CAPABILITY_ALLOWLIST,
    private readonly dispatcher = new ToolDispatcher(),
  ) {
    this.byId = new Map(connectors.map((connector) => [connector.id, connector]));
    for (const connector of connectors) for (const action of connector.actions) {
      const id = `${connector.id}.${action.name}`;
      const rule = TOOL_RISK_REGISTRY[id];
      if (!rule || rule.risk !== action.mode) throw new Error(`Tool risk map is missing or mismatched for ${id}.`);
    }
  }

  async statuses(selected: Connector[] = this.connectors): Promise<ConnectorStatus[]> {
    return Promise.all(selected.map(async (connector) => {
      try {
        const probe = await connector.probe();
        return {
          id: connector.id,
          label: connector.label,
          category: connector.category,
          setup: connector.setup,
          actions: connector.actions.map(({ run: _run, ...summary }) => summary),
          ...probe,
        };
      } catch (error) {
        return {
          id: connector.id,
          label: connector.label,
          category: connector.category,
          setup: connector.setup,
          available: false,
          connected: false,
          detail: error instanceof Error ? error.message : "Connector probe failed.",
          actions: connector.actions.map(({ run: _run, ...summary }) => summary),
        };
      }
    }));
  }

  async status(service: string) {
    const connector = this.byId.get(service);
    if (!connector) return null;
    return (await this.statuses([connector]))[0] ?? null;
  }

  selectCapabilities(request: CapabilitySelectionRequest) {
    return selectCapabilityManifest(
      this.connectors,
      request,
      this.capabilityAllowlist,
    );
  }

  async discover(query: string, requestedCapabilityIds: readonly string[] = []) {
    const request: CapabilitySelectionRequest = { task: query, requestedCapabilityIds };
    const manifest = this.selectCapabilities(request);
    recordContextSnapshot(
      "connectors.capabilities",
      "selection.completed",
      manifest,
      [
        {
          name: "capability_request",
          source: "discover_services.query",
          provenance: "user",
          value: query,
        },
        {
          name: "capability_manifest",
          source: "selectCapabilityManifest",
          provenance: "tool",
          value: manifest,
        },
      ],
      {
        requestTokenCount: manifest.request.tokenCount,
        selectedServiceCount: manifest.capabilities.length,
        selectedActionCount: manifest.selectedCapabilityIds.length,
        omittedActionCount:
          manifest.omitted.notAllowlisted +
          manifest.omitted.irrelevant +
          manifest.omitted.overLimit,
      },
    );
    const selectedByService = new Map(
      manifest.capabilities.map((service) => [
        service.id,
        new Set(service.actions.map((action) => action.name)),
      ]),
    );
    const selectedConnectors = this.connectors.filter((connector) =>
      selectedByService.has(connector.id));
    const statuses = await this.statuses(selectedConnectors);
    return statuses.map((connector) => ({
      ...connector,
      actions: connector.actions.filter((action) =>
        selectedByService.get(connector.id)?.has(action.name)),
    }));
  }

  prepare(service: string, actionName: string, rawArguments: unknown): ConnectorCall {
    const connector = this.byId.get(service);
    if (!connector) throw new Error(`Unknown service: ${service}. Use discover_services first.`);
    const action = connector.actions.find((candidate) => candidate.name === actionName);
    if (!action) throw new Error(`Unknown ${connector.label} action: ${actionName}. Use discover_services first.`);
    return {
      service,
      action: actionName,
      arguments: safeArguments(action, rawArguments),
      mode: action.mode,
      label: connector.label,
    };
  }

  async execute(
    call: ConnectorCall,
    signal: AbortSignal,
    progress: (message: string) => void = () => {},
    authority?: { taskId: string; approvalScope: ExactToolApproval },
  ): Promise<ConnectorInvocationResult> {
    const connector = this.byId.get(call.service);
    const action = connector?.actions.find((candidate) => candidate.name === call.action);
    if (!connector || !action) throw new Error("The requested connector action is no longer available.");
    const prepared = this.prepare(call.service, call.action, call.arguments);
    if (prepared.mode !== call.mode || JSON.stringify(prepared.arguments) !== JSON.stringify(call.arguments)) {
      throw new Error("Connector call changed after validation.");
    }
    const actionId = `${call.service}.${call.action}`;
    const policy = evaluateToolAction({
      actionId, args: call.arguments, taskId: authority?.taskId,
      approvalScope: authority?.approvalScope,
    });
    if (policy.decision !== "allow") throw new Error(`Connector action ${policy.decision}: ${policy.reason}.`);
    diagnosticLog("connectors", "action.started", {
      service: call.service,
      action: call.action,
      mode: call.mode,
      argumentNames: Object.keys(call.arguments),
    });
    const result = await this.dispatcher.execute({
      key: authority?.taskId ? `${authority.taskId}:${actionId}` : `${actionId}:${toolArgumentsHash(call.arguments)}:${randomUUID()}`,
      actionId,
      argsHash: toolArgumentsHash(call.arguments),
      sideEffect: action.mode === "write",
      timeoutMs: policy.timeoutMs,
      signal,
      run: (toolSignal) => action.run(call.arguments, { signal: toolSignal, progress }),
      onStatus: (record) => diagnosticLog("connectors", "action.lifecycle", {
        actionId, taskId: authority?.taskId, status: record.status,
        argsHash: record.argsHash,
      }),
    });
    diagnosticLog("connectors", "action.completed", {
      service: call.service,
      action: call.action,
      mode: call.mode,
      summaryChars: result.summary.length,
    });
    return result;
  }
}

export class ConnectorRoutingTaskExecutor implements TaskExecutor {
  constructor(
    private readonly connectors: ConnectorGateway,
    private readonly fallback: TaskExecutor,
  ) {}

  async execute(
    goal: string,
    signal: AbortSignal,
    progress: (message: string) => void,
    usage?: Parameters<TaskExecutor["execute"]>[3],
    accountUsage?: Parameters<TaskExecutor["execute"]>[4],
    execution?: Parameters<TaskExecutor["execute"]>[5],
  ): Promise<ExecutionResult> {
    if (!execution?.connectorCall) {
      return this.fallback.execute(goal, signal, progress, usage, accountUsage, execution);
    }
    const call = execution.connectorCall;
    const taskId = execution.taskId;
    const scope = taskId && createTaskAuthorityScope({
      taskId, goal, taskKind: "connector", connectorCall: call,
    });
    const approved = scope && evaluateTaskAuthority(execution.authority, scope, new Date()).decision === "allow";
    if (!approved || !taskId || !execution.authority?.expiresAt) {
      throw new Error("Connector write/read Task authority is missing or has changed.");
    }
    const approvalScope = exactToolApproval(
      taskId, `${call.service}.${call.action}`, call.arguments, execution.authority.expiresAt,
    );
    const result = await this.connectors.execute(call, signal, progress, { taskId, approvalScope });
    return {
      summary: result.summary,
      verified: true,
      artifacts: result.artifacts,
    };
  }
}
