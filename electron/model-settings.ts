import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AppServerConnection } from "./conversation-client.js";
import { diagnosticLog } from "./diagnostics.js";

export type ModelRole =
  | "conversation"
  | "general"
  | "coding"
  | "computer"
  | "browser"
  | "memory";

export type TaskKind = "general" | "coding" | "computer" | "browser";

export interface ModelSelection {
  model: string;
  effort: string;
}

export type ModelSettings = Record<ModelRole, ModelSelection>;

export interface ModelCatalogEntry {
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string;
}

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  conversation: { model: "gpt-5.6-terra", effort: "low" },
  general: { model: "gpt-5.6-terra", effort: "medium" },
  coding: { model: "gpt-6-luna", effort: "low" },
  computer: { model: "gpt-5.6-sol", effort: "medium" },
  browser: { model: "gpt-5.6-sol", effort: "medium" },
  memory: { model: "gpt-5.6-terra", effort: "low" },
};

const ROLES = Object.keys(DEFAULT_MODEL_SETTINGS) as ModelRole[];

export class ModelSettingsStore {
  private settings: ModelSettings = structuredClone(DEFAULT_MODEL_SETTINGS);

  constructor(private readonly path: string) {}

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as Partial<ModelSettings>;
      for (const role of ROLES) {
        const candidate = raw[role];
        if (candidate?.model && candidate.effort) {
          // Migrate the former coding default so an existing install does not
          // silently launch the new Pi provider with an unsupported selection.
          if (role === "coding" && candidate.model === "gpt-5.6-sol" && candidate.effort === "high") {
            this.settings.coding = { model: "gpt-6-luna", effort: "low" };
            continue;
          }
          this.settings[role] = {
            model: String(candidate.model),
            effort: String(candidate.effort),
          };
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        diagnosticLog("models", "settings.load_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return this.get();
  }

  get() {
    return structuredClone(this.settings);
  }

  selection(role: ModelRole) {
    return structuredClone(this.settings[role]);
  }

  async update(next: ModelSettings) {
    for (const role of ROLES) {
      const selection = next[role];
      if (!selection?.model || !selection.effort) {
        throw new Error(`A model and reasoning level are required for ${role}.`);
      }
    }
    this.settings = structuredClone(next);
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.settings, null, 2), "utf8");
    diagnosticLog("models", "settings.updated", { settings: this.settings });
    return this.get();
  }
}

export async function listAvailableModels(): Promise<ModelCatalogEntry[]> {
  const connection = new AppServerConnection("models.catalog");
  try {
    await connection.start();
    const result = await connection.request("model/list", {
      limit: 100,
      includeHidden: false,
    });
    return (result.data ?? []).map((model: Record<string, any>) => ({
      model: String(model.model),
      displayName: String(model.displayName ?? model.model),
      description: String(model.description ?? ""),
      isDefault: model.isDefault === true,
      supportedReasoningEfforts: (model.supportedReasoningEfforts ?? [])
        .map((option: Record<string, unknown>) => String(option.reasoningEffort)),
      defaultReasoningEffort: String(model.defaultReasoningEffort ?? "medium"),
    }));
  } finally {
    connection.stop("model catalog loaded");
  }
}
