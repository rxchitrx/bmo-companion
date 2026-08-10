import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConnectorCommandRunner } from "./connector-types.js";

export class AppleBridge {
  private binaryPromise: Promise<string> | null = null;

  constructor(
    private readonly runner: ConnectorCommandRunner,
    private readonly sourcePath: string,
    private readonly binaryPath: string,
  ) {}

  async call(
    operation: string,
    argumentsObject: Record<string, string | number | boolean>,
    signal?: AbortSignal,
  ) {
    const binary = await this.ensureBinary();
    const result = await this.runner.run(binary, [operation], {
      signal,
      stdin: JSON.stringify(argumentsObject),
      timeoutMs: 45_000,
    });
    const text = result.stdout.trim();
    return text ? JSON.parse(text) as unknown : null;
  }

  private ensureBinary() {
    if (!this.binaryPromise) this.binaryPromise = this.compile();
    return this.binaryPromise;
  }

  private async compile() {
    if (!this.runner.exists("swiftc")) {
      throw new Error("Apple connector helper requires Xcode Command Line Tools.");
    }
    const source = await readFile(this.sourcePath, "utf8");
    await mkdir(dirname(this.binaryPath), { recursive: true });
    const stampPath = `${this.binaryPath}.source`;
    let previous = "";
    try { previous = await readFile(stampPath, "utf8"); } catch {}
    if (previous !== source || !this.runner.exists(this.binaryPath)) {
      await this.runner.run("swiftc", [
        "-O",
        this.sourcePath,
        "-o",
        this.binaryPath,
      ], { timeoutMs: 120_000 });
      await writeFile(stampPath, source, "utf8");
    }
    return this.binaryPath;
  }
}

export function defaultAppleBridgePaths(currentDirectory: string, userDataPath: string) {
  return {
    sourcePath: join(currentDirectory, "native", "BMOAppleBridge.swift"),
    binaryPath: join(userDataPath, "native", "BMOAppleBridge"),
  };
}
