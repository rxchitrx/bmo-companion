import { createHash } from "node:crypto";
import type { ConnectorGateway } from "./connector-gateway.js";
import type { ActivityLedger } from "./task-runtime.js";
import { diagnosticLog } from "./diagnostics.js";

export interface ConnectorWatch {
  id: string;
  service: string;
  action: string;
  notify?: boolean;
  arguments(): Record<string, string | number | boolean>;
}

export interface ConnectorSignal {
  id: string;
  service: string;
  action: string;
  observedAt: string;
  summary: string;
  notify: boolean;
}

const fingerprint = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

export class ConnectorEventMonitor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly baseline = new Map<string, string>();
  private pending: ConnectorSignal[] = [];

  constructor(
    private readonly gateway: ConnectorGateway,
    private readonly watches: ConnectorWatch[],
    private readonly emit: (
      signal: ConnectorSignal,
    ) => boolean | void | Promise<boolean | void>,
    private readonly ledger: ActivityLedger,
    private readonly intervalMs = 5 * 60_000,
  ) {}

  start() {
    if (this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  pendingCount() {
    return this.pending.length;
  }

  async flushPending(
    deliver: (signal: ConnectorSignal) => boolean | Promise<boolean>,
  ) {
    const remaining: ConnectorSignal[] = [];
    for (const signal of this.pending) {
      try {
        if (!await deliver(signal)) remaining.push(signal);
      } catch {
        remaining.push(signal);
      }
    }
    this.pending = remaining;
    return this.pending.length;
  }

  async pollOnce() {
    if (this.running) return;
    this.running = true;
    try {
      for (const watch of this.watches) {
        try {
          const status = await this.gateway.status(watch.service);
          if (!status?.connected) continue;
          const call = this.gateway.prepare(watch.service, watch.action, watch.arguments());
          if (call.mode !== "read") continue;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 60_000);
          let summary = "";
          try {
            summary = (await this.gateway.execute(call, controller.signal)).summary;
          } finally {
            clearTimeout(timeout);
          }
          const next = fingerprint(summary);
          const previous = this.baseline.get(watch.id);
          this.baseline.set(watch.id, next);
          if (!previous || previous === next) continue;
          const signal: ConnectorSignal = {
            id: `${watch.id}:${next}`,
            service: watch.service,
            action: watch.action,
            observedAt: new Date().toISOString(),
            summary: summary.slice(0, 6_000),
            notify: watch.notify === true,
          };
          await this.ledger.append({
            type: "connector.signal",
            at: signal.observedAt,
            signalId: signal.id,
            service: signal.service,
            action: signal.action,
            fingerprint: next,
          });
          diagnosticLog("connectors.events", "change.detected", {
            service: signal.service,
            action: signal.action,
            fingerprint: next,
          });
          const delivered = await this.emit(signal);
          if (delivered !== true) {
            this.pending = [
              ...this.pending.filter((candidate) => candidate.id !== signal.id),
              signal,
            ].slice(-50);
          }
        } catch (error) {
          diagnosticLog("connectors.events", "watch.failed", {
            watchId: watch.id,
            service: watch.service,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}

export function defaultConnectorWatches(): ConnectorWatch[] {
  return [
    {
      id: "calendar.next-day",
      service: "calendar",
      action: "list_events",
      notify: true,
      arguments: () => ({
        start: new Date().toISOString(),
        end: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        limit: 50,
      }),
    },
    {
      id: "reminders.open",
      service: "reminders",
      action: "list_reminders",
      notify: true,
      arguments: () => ({ includeCompleted: false }),
    },
    {
      id: "github.notifications",
      service: "github",
      action: "notifications",
      notify: true,
      arguments: () => ({ all: false, limit: 30 }),
    },
    {
      id: "gmail.unread",
      service: "google",
      action: "search_gmail",
      notify: true,
      arguments: () => ({ query: "is:unread newer_than:1d", limit: 20 }),
    },
    {
      id: "todoist.open",
      service: "todoist",
      action: "list_tasks",
      arguments: () => ({ limit: 50 }),
    },
  ];
}
