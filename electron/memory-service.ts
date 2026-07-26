import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type MemoryKind = "episodic" | "semantic" | "artifact";
export type Sensitivity = "low" | "sensitive";
export type CandidateState = "active" | "review";

export interface ArtifactInput {
  label: string;
  sourceName: string;
  sourceUrl?: string;
}

export interface MemoryCandidate {
  id: string;
  kind: MemoryKind;
  state: CandidateState;
  taskId: string;
  ledgerReference: string;
  text: string;
  sensitivity: Sensitivity;
  confidence: number;
  corroborated: boolean;
  source?: ArtifactInput;
  createdAt: string;
}

export interface RecallAnswer {
  answer: string;
  references: Array<{ taskId: string; ledgerReference: string; source?: ArtifactInput }>;
}

export interface MemoryStore {
  load(): Promise<MemoryCandidate[]>;
  save(records: MemoryCandidate[]): Promise<void>;
}

/** Local-only store: it persists bounded Companion records, never fetched source bodies. */
export class JsonMemoryStore implements MemoryStore {
  constructor(private readonly path: string) {}

  async load(): Promise<MemoryCandidate[]> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as MemoryCandidate[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async save(records: MemoryCandidate[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(records), "utf8");
  }
}

export interface CompletedTaskMemoryInput {
  taskId: string;
  goal: string;
  summary: string;
  artifacts?: ArtifactInput[];
  sensitivity?: Sensitivity;
  confidence?: number;
  corroborated?: boolean;
}

const tokens = (value: string) => new Set(
  value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [],
);

export class CompanionMemoryService {
  private records: MemoryCandidate[] | null = null;

  constructor(
    private readonly store: MemoryStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async rememberCompletedTask(input: CompletedTaskMemoryInput): Promise<MemoryCandidate[]> {
    this.rejectRawSourceContent(input);
    const sensitivity = input.sensitivity ?? "low";
    const confidence = input.confidence ?? 0.95;
    const corroborated = input.corroborated ?? true;
    const ledgerReference = `ledger://tasks/${input.taskId}`;
    const createdAt = this.now();
    const state = this.promotionState(sensitivity, confidence, corroborated);
    const summary = input.summary.trim().slice(0, 500);
    const goal = input.goal.trim().slice(0, 300);
    const records: MemoryCandidate[] = [
      this.candidate("episodic", state, input.taskId, ledgerReference, `Task: ${goal}. Outcome: ${summary}`, sensitivity, confidence, corroborated, createdAt),
      this.candidate("semantic", state, input.taskId, ledgerReference, summary, sensitivity, confidence, corroborated, createdAt),
      ...(input.artifacts?.map((source) => this.candidate("artifact", state, input.taskId, ledgerReference, source.label.slice(0, 300), sensitivity, confidence, corroborated, createdAt, source)) ?? []),
    ];
    // An outcome without an external artifact still has a bounded Ledger reference.
    if (!input.artifacts?.length) {
      records.push(this.candidate("artifact", state, input.taskId, ledgerReference, "Verified Task outcome", sensitivity, confidence, corroborated, createdAt));
    }
    const current = await this.all();
    this.records = [...current, ...records];
    await this.store.save(this.records);
    return structuredClone(records);
  }

  async recall(question: string): Promise<RecallAnswer> {
    const query = tokens(question);
    const activeRecords = (await this.all()).filter((record) => record.state === "active");
    const matches = activeRecords
      .map((record) => ({ record, score: [...tokens(record.text)].filter((token) => query.has(token)).length }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || b.record.createdAt.localeCompare(a.record.createdAt))
      .slice(0, 3)
      .map(({ record }) => record);
    if (!matches.length) {
      return { answer: "I don’t have a relevant completed Task in local memory yet.", references: [] };
    }
    const episodes = matches.filter((record) => record.kind !== "artifact");
    const answer = episodes.map((record) => record.text).join(" ");
    const supportingArtifacts = activeRecords.filter((record) => record.kind === "artifact" && matches.some((match) => match.taskId === record.taskId));
    const seen = new Set<string>();
    const references = [...matches, ...supportingArtifacts].flatMap((record) => {
      const key = `${record.taskId}:${record.source?.sourceUrl ?? record.ledgerReference}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ taskId: record.taskId, ledgerReference: record.ledgerReference, source: record.source }];
    });
    return { answer, references };
  }

  private async all() {
    if (!this.records) this.records = await this.store.load();
    return this.records;
  }

  private promotionState(sensitivity: Sensitivity, confidence: number, corroborated: boolean): CandidateState {
    return sensitivity === "low" && confidence >= 0.9 && corroborated ? "active" : "review";
  }

  private candidate(kind: MemoryKind, state: CandidateState, taskId: string, ledgerReference: string, text: string, sensitivity: Sensitivity, confidence: number, corroborated: boolean, createdAt: string, source?: ArtifactInput): MemoryCandidate {
    return { id: randomUUID(), kind, state, taskId, ledgerReference, text, sensitivity, confidence, corroborated, source, createdAt };
  }

  private rejectRawSourceContent(input: CompletedTaskMemoryInput) {
    if ("rawSourceContent" in input || input.artifacts?.some((artifact) => "content" in artifact)) {
      throw new Error("External Source content cannot be stored in Companion memory.");
    }
  }
}
