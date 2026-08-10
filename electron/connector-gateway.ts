import type {
  Connector,
  ConnectorAction,
  ConnectorCall,
  ConnectorInvocationResult,
  ConnectorStatus,
} from "./connector-types.js";
import type { ExecutionResult, TaskExecutor } from "./task-runtime.js";
import { diagnosticLog } from "./diagnostics.js";

const tokens = (value: string) =>
  new Set(value.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []);

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

  constructor(private readonly connectors: Connector[]) {
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

  async discover(query: string) {
    const wanted = tokens(query);
    const selected = this.connectors.filter((connector) => {
      if (!wanted.size) return true;
      const connectorTokens = tokens([
        connector.id,
        connector.label,
        connector.category,
        ...connector.actions.flatMap((item) => [item.name, item.label, item.description]),
      ].join(" "));
      return [...wanted].some((token) => connectorTokens.has(token));
    });
    const status = await this.statuses(selected);
    return status
      .map((connector) => {
        const matchingActions = connector.actions.filter((item) => {
          if (!wanted.size) return true;
          const haystack = tokens(`${connector.id} ${connector.label} ${item.name} ${item.label} ${item.description}`);
          return [...wanted].some((token) => haystack.has(token));
        });
        return { ...connector, actions: matchingActions };
      })
      .filter((connector) => connector.actions.length > 0 || !wanted.size);
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
