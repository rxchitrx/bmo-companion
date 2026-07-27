export interface ProtocolItem {
  id?: string;
  type?: string;
}

export interface ProtocolSettlement {
  settled: boolean;
  activeItems: Array<{ id: string; type: string }>;
  pendingServerRequests: number;
  quietForMs: number;
}

/**
 * Tracks the app-server objects owned by one turn. A Task may not publish a
 * terminal result until the turn is complete, every started item is terminal,
 * every server request has a reply, and the stream has stayed quiet briefly.
 */
export class CodexTaskLifecycle {
  private readonly activeItems = new Map<string, string>();
  private readonly pendingServerRequests = new Set<number>();
  private lastEventAt: number;
  private turnFinished = false;
  private revoked = false;

  constructor(private readonly now: () => number = () => Date.now()) {
    this.lastEventAt = now();
  }

  itemStarted(item: ProtocolItem) {
    if (this.revoked || !item.id) return;
    this.activeItems.set(item.id, item.type ?? "unknown");
    this.touch();
  }

  itemCompleted(item: ProtocolItem) {
    if (item.id) this.activeItems.delete(item.id);
    this.touch();
  }

  serverRequestStarted(id: number | undefined) {
    if (this.revoked || id == null) return;
    this.pendingServerRequests.add(id);
    this.touch();
  }

  serverRequestReplied(id: number | undefined) {
    if (id != null) this.pendingServerRequests.delete(id);
    this.touch();
  }

  turnCompleted() {
    this.turnFinished = true;
    this.touch();
  }

  revoke() {
    this.revoked = true;
    this.activeItems.clear();
    this.pendingServerRequests.clear();
    this.touch();
  }

  snapshot(): ProtocolSettlement {
    return {
      settled:
        !this.revoked &&
        this.turnFinished &&
        this.activeItems.size === 0 &&
        this.pendingServerRequests.size === 0,
      activeItems: [...this.activeItems].map(([id, type]) => ({ id, type })),
      pendingServerRequests: this.pendingServerRequests.size,
      quietForMs: Math.max(0, this.now() - this.lastEventAt),
    };
  }

  async waitForSettlement(
    signal: AbortSignal,
    options: { timeoutMs?: number; quietMs?: number } = {},
  ): Promise<ProtocolSettlement> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    const quietMs = options.quietMs ?? 350;
    const deadline = this.now() + timeoutMs;
    while (!signal.aborted && this.now() < deadline) {
      const snapshot = this.snapshot();
      if (snapshot.settled && snapshot.quietForMs >= quietMs) return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (signal.aborted) {
      this.revoke();
      throw new Error("Task authority was revoked while settling Codex work.");
    }
    return this.snapshot();
  }

  private touch() {
    this.lastEventAt = this.now();
  }
}
