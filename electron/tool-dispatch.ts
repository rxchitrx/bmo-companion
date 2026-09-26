import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

export type ToolCallStatus = "queued" | "aborted-before-dispatch" | "dispatched" |
  "completed" | "cancelled" | "timed-out" | "reconcile-required";
export interface ToolCallRecord {
  key: string;
  actionId: string;
  argsHash: string;
  status: ToolCallStatus;
  updatedAt: string;
}
export interface ToolCallJournal {
  get(key: string): Promise<ToolCallRecord | undefined>;
  put(record: ToolCallRecord): Promise<void>;
}

/** Atomic local journal. Records only hashes and state, never arguments or tool output. */
export class JsonToolCallJournal implements ToolCallJournal {
  private pending = Promise.resolve();
  constructor(private readonly path: string) {}

  async get(key: string): Promise<ToolCallRecord | undefined> {
    await this.pending;
    const records = await this.read();
    return records[key];
  }

  put(record: ToolCallRecord): Promise<void> {
    const operation = this.pending.then(async () => {
      const records = await this.read();
      records[record.key] = record;
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(records));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
      const directory = await open(dirname(this.path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  private async read(): Promise<Record<string, ToolCallRecord>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid tool call journal.");
      return parsed as Record<string, ToolCallRecord>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
}

export class ReconciliationRequiredError extends Error {
  constructor(message: string) { super(message); this.name = "ReconciliationRequiredError"; }
}

export interface DispatchToolCall<T> {
  key: string;
  actionId: string;
  argsHash: string;
  sideEffect: boolean;
  timeoutMs: number;
  signal: AbortSignal;
  run(signal: AbortSignal): Promise<T>;
  /** Read-only observation of the external state. Never repeats the action. */
  reconcile?: () => Promise<{ completed: boolean; result?: T }>;
  onStatus?: (record: ToolCallRecord) => void;
}

export class ToolDispatcher {
  private readonly active = new Map<string, { promise: Promise<unknown>; actionId: string; argsHash: string }>();
  constructor(private readonly journal?: ToolCallJournal) {}

  execute<T>(call: DispatchToolCall<T>): Promise<T> {
    const existing = this.active.get(call.key);
    if (existing) {
      if (existing.actionId !== call.actionId || existing.argsHash !== call.argsHash) {
        return Promise.reject(new Error("A tool call key was reused for a different action or arguments."));
      }
      return existing.promise as Promise<T>;
    }
    const operation = this.executeOnce(call);
    this.active.set(call.key, { promise: operation, actionId: call.actionId, argsHash: call.argsHash });
    void operation.finally(() => {
      if (this.active.get(call.key)?.promise === operation) this.active.delete(call.key);
    }).catch(() => undefined);
    return operation;
  }

  private async executeOnce<T>(call: DispatchToolCall<T>): Promise<T> {
    const record = async (status: ToolCallStatus) => {
      const entry: ToolCallRecord = {
        key: call.key, actionId: call.actionId, argsHash: call.argsHash,
        status, updatedAt: new Date().toISOString(),
      };
      if (call.sideEffect) {
        if (!this.journal) throw new Error("Side-effect tools require a durable call journal.");
        await this.journal.put(entry);
      }
      call.onStatus?.(entry);
    };
    const prior = call.sideEffect ? await this.journal?.get(call.key) : undefined;
    if (prior) {
      if (prior.actionId !== call.actionId || prior.argsHash !== call.argsHash) {
        throw new Error("A tool call key was reused for a different action or arguments.");
      }
      if (!["queued", "aborted-before-dispatch"].includes(prior.status)) {
        const observed = await call.reconcile?.();
        if (observed?.completed && observed.result !== undefined) {
          await record("completed");
          return observed.result;
        }
        await record("reconcile-required");
        throw new ReconciliationRequiredError(
          `The earlier ${call.actionId} call may already have changed external state. Review the existing result before another attempt.`,
        );
      }
    }
    await record("queued");
    if (call.signal.aborted) {
      await record("aborted-before-dispatch");
      throw new Error("Tool call was aborted before dispatch.");
    }
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let removeAbort: (() => void) | undefined;
    if (call.signal.aborted) {
      await record("aborted-before-dispatch");
      throw new Error("Tool call was aborted before dispatch.");
    }
    await record("dispatched");
    if (call.signal.aborted) {
      await record("aborted-before-dispatch");
      throw new Error("Tool call was aborted before dispatch.");
    }
    const interruption = new Promise<never>((_resolve, reject) => {
      const abort = () => { controller.abort(); reject(new Error("Tool call was cancelled.")); };
      call.signal.addEventListener("abort", abort, { once: true });
      removeAbort = () => call.signal.removeEventListener("abort", abort);
      timer = setTimeout(() => { controller.abort(); reject(new Error(`Tool call timed out after ${call.timeoutMs} ms.`)); }, call.timeoutMs);
      if (call.signal.aborted) abort();
    });
    try {
      const outcome = await Promise.race([
        Promise.resolve().then(() => {
          if (controller.signal.aborted) throw new Error("Tool call was cancelled before invocation.");
          return call.run(controller.signal);
        }), interruption,
      ]);
      if (call.signal.aborted || controller.signal.aborted) throw new Error("Tool call was cancelled.");
      await record("completed");
      return outcome;
    } catch (error) {
      await record(call.signal.aborted ? "cancelled" : controller.signal.aborted ? "timed-out" : "reconcile-required");
      if (call.sideEffect && !call.signal.aborted) {
        throw new ReconciliationRequiredError(
          `${call.actionId} may have changed external state before the call ended. Inspect the existing result before retrying. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    } finally {
      removeAbort?.();
      if (timer) clearTimeout(timer);
    }
  }
}
