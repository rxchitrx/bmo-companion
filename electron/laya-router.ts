import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

export type VoiceRoute = "conversation" | "project" | "coding" | "connector" | "browser" | "computer";
export interface RouteDecision { route: VoiceRoute; confidence: number; source: "laya"; }
const ROUTES = new Set<VoiceRoute>(["conversation", "project", "coding", "connector", "browser", "computer"]);

/** A local, optional classifier. Its output never grants tools or Task authority. */
export class LayaRouter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private pending = new Map<string, (value: RouteDecision | null) => void>();
  constructor(private readonly python = process.env.BMO_LAYA_PYTHON ?? [
    join(homedir(), ".local/share/bmo/laya/bin/python"), join(process.cwd(), "work/laya-env/bin/python"),
  ].find(existsSync) ?? "") {}
  get available() { return existsSync(this.python); }
  private start() {
    if (this.child || !this.available) return;
    const here = dirname(fileURLToPath(import.meta.url));
    const compiled = join(here, "laya-router.py");
    const source = join(here, "../electron/laya-router.py");
    this.child = spawn(this.python, [existsSync(compiled) ? compiled : source], {
      stdio: ["pipe", "pipe", "pipe"],
      env: Object.fromEntries(["HOME", "PATH", "TMPDIR", "LANG", "HF_HOME"].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : [])),
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 20_000) { this.close(); return; }
      for (;;) {
        const index = this.buffer.indexOf("\n");
        if (index < 0) break;
        const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
        try {
          const value = JSON.parse(line) as { id?: string; route?: VoiceRoute; confidence?: number };
          const settle = this.pending.get(value.id ?? "");
          if (!settle) continue;
          this.pending.delete(value.id!);
          settle(value.route && ROUTES.has(value.route) && typeof value.confidence === "number" && value.confidence >= 0 && value.confidence <= 1
            ? { route: value.route, confidence: value.confidence, source: "laya" } : null);
        } catch { this.close(); return; }
      }
    });
    this.child.on("error", () => this.close());
    this.child.on("exit", () => this.close());
  }
  async route(text: string, timeoutMs = 5_000): Promise<RouteDecision | null> {
    if (!text.trim() || !this.available) return null;
    this.start();
    if (!this.child) return null;
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null); }, timeoutMs);
      this.pending.set(id, (decision) => { clearTimeout(timer); resolve(decision); });
      this.child?.stdin.write(`${JSON.stringify({ id, text: text.slice(0, 2000) })}\n`, (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(id); resolve(null); }
      });
    });
  }
  close() {
    const child = this.child; this.child = null; this.buffer = "";
    for (const settle of this.pending.values()) settle(null);
    this.pending.clear(); child?.kill("SIGTERM");
  }
}
