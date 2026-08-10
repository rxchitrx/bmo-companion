import type {
  Connector,
  ConnectorAction,
  ConnectorCall,
  ConnectorInvocationResult,
  ConnectorStatus,
} from "./connector-types.js";
import type { ExecutionResult, TaskExecutor } from "./task-runtime.js";
import { diagnosticLog } from "./diagnostics.js";
import { recordContextSnapshot } from "./context-telemetry.js";
import {
  MODEL_VISIBLE_CAPABILITY_ALLOWLIST,
  selectCapabilityManifest,
  type CapabilitySelectionRequest,
} from "./capability-selection.js";

function safeArguments(
  action: ConnectorAction,
  raw: unknown,
): Record<string, string | number | boolean> {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const allowed = new Map(action.parameters.map((parameter) => [parameter.name, parameter]));
  const result: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(source)) {
    const parameter = allowed.get(name);
    if (!parameter || value == null) continue;
    if (parameter.type === "string" && typeof value === "string") result[name] = value.slice(0, 50_000);
    else if (parameter.type === "number" && typeof value === "number" && Number.isFinite(value)) result[name] = value;
    else if (parameter.type === "boolean" && typeof value === "boolean") result[name] = value;
    else throw new Error(`${name} must be a ${parameter.type}.`);
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
  ) {
    this.byId = new Map(connectors.map((connector) => [connector.id, connector]));
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
  ): Promise<ConnectorInvocationResult> {
    const connector = this.byId.get(call.service);
    const action = connector?.actions.find((candidate) => candidate.name === call.action);
    if (!connector || !action) throw new Error("The requested connector action is no longer available.");
    diagnosticLog("connectors", "action.started", {
      service: call.service,
      action: call.action,
      mode: call.mode,
      argumentNames: Object.keys(call.arguments),
    });
    const result = await action.run(call.arguments, { signal, progress });
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
    const result = await this.connectors.execute(execution.connectorCall, signal, progress);
    return {
      summary: result.summary,
      verified: true,
      artifacts: result.artifacts,
    };
  }
}
