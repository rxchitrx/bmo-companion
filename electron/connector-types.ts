import type { ExecutionResult } from "./task-runtime.js";

export type ConnectorMode = "read" | "write";
export type ConnectorParameterType = "string" | "number" | "boolean";

export interface ConnectorParameter {
  name: string;
  type: ConnectorParameterType;
  description: string;
  required?: boolean;
}

export interface ConnectorActionSummary {
  name: string;
  label: string;
  description: string;
  mode: ConnectorMode;
  parameters: ConnectorParameter[];
}

export interface ConnectorStatus {
  id: string;
  label: string;
  category: "apple" | "work" | "knowledge" | "security";
  available: boolean;
  connected: boolean;
  detail: string;
  setup?: string;
  actions: ConnectorActionSummary[];
}

export interface ConnectorCall {
  service: string;
  action: string;
  arguments: Record<string, string | number | boolean>;
  mode: ConnectorMode;
  label: string;
}

export interface ConnectorInvocationResult {
  summary: string;
  data?: unknown;
  artifacts?: ExecutionResult["artifacts"];
}

export interface ConnectorExecutionContext {
  signal: AbortSignal;
  progress(message: string): void;
}

export interface ConnectorAction extends ConnectorActionSummary {
  run(
    args: Record<string, string | number | boolean>,
    context: ConnectorExecutionContext,
  ): Promise<ConnectorInvocationResult>;
}

export interface Connector {
  id: string;
  label: string;
  category: ConnectorStatus["category"];
  setup?: string;
  probe(): Promise<Omit<ConnectorStatus, "id" | "label" | "category" | "setup" | "actions">>;
  actions: ConnectorAction[];
}

export interface ConnectorCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ConnectorCommandRunner {
  exists(binary: string): boolean;
  run(
    binary: string,
    args: string[],
    options?: {
      signal?: AbortSignal;
      stdin?: string;
      timeoutMs?: number;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<ConnectorCommandResult>;
}
