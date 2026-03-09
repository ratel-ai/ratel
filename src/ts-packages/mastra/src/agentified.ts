import { ApiClient } from "@agentified/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { resolveBinaryPath, findFreePort } from "./spawn-utils.js";

export class DatasetRef {
  constructor(
    readonly agentified: Agentified,
    readonly datasetName: string,
  ) {}
}

export class Agentified {
  /** @internal */ sdk: ApiClient | null = null;
  private connected = false;
  private spawnedProcess: ChildProcess | null = null;
  private activeInstances: Set<string> = new Set();
  private heartbeatIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();
  private cleanupHandlers: Array<[string, (...args: any[]) => void]> = [];
  private restartCount = 0;
  private lastRestartAt = 0;
  private spawnArgs: { binaryPath: string; port: number } | null = null;

  async connect(serverUrl?: string): Promise<void> {
    if (!serverUrl) {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY environment variable is required for local spawn");
      }
      const binaryPath = resolveBinaryPath();
      if (!binaryPath) {
        throw new Error("Could not resolve agentified core binary. Install the platform-specific package.");
      }

      const port = await findFreePort();
      this.spawnArgs = { binaryPath, port };
      this.spawnChild();

      const url = `http://127.0.0.1:${port}`;
      await this.healthCheckLoop(url);

      this.registerCleanupHandlers();
      this.registerCrashHandler();

      this.sdk = new ApiClient({ serverUrl: url, tools: [] });
      this.connected = true;
      return;
    }

    const res = await fetch(`${serverUrl}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(`Health check failed: ${res.status}`);
    }

    this.sdk = new ApiClient({ serverUrl, tools: [] });
    this.connected = true;
  }

  dataset(name: string): DatasetRef {
    return new DatasetRef(this, name);
  }

  private spawnChild(): void {
    if (!this.spawnArgs) return;
    const { binaryPath, port } = this.spawnArgs;
    const child = spawn(binaryPath, ["--port", String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    this.spawnedProcess = child;
  }

  private registerCrashHandler(): void {
    if (!this.spawnedProcess) return;
    this.spawnedProcess.on("exit", (code, signal) => {
      if (!this.connected) return; // intentional shutdown
      const now = Date.now();
      if (this.restartCount >= 1 || now - this.lastRestartAt < 60_000) return;
      this.restartCount++;
      this.lastRestartAt = now;
      this.spawnChild();
      this.registerCrashHandler();
    });
  }

  private registerCleanupHandlers(): void {
    const cleanup = () => {
      if (this.spawnedProcess) {
        this.spawnedProcess.kill("SIGTERM");
        const child = this.spawnedProcess;
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already dead */ }
        }, 2000);
        this.spawnedProcess = null;
      }
    };

    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => { cleanup(); process.exit(); };
      process.on(sig, handler);
      this.cleanupHandlers.push([sig, handler]);
    }

    const exitHandler = () => { cleanup(); };
    process.on("exit", exitHandler);
    this.cleanupHandlers.push(["exit", exitHandler]);
  }

  private removeCleanupHandlers(): void {
    for (const [event, handler] of this.cleanupHandlers) {
      process.removeListener(event, handler);
    }
    this.cleanupHandlers = [];
  }

  /** @internal */ healthCheckDelayMs = 200;
  /** @internal */ healthCheckMaxAttempts = 25;

  private async healthCheckLoop(url: string): Promise<void> {
    for (let i = 0; i < this.healthCheckMaxAttempts; i++) {
      try {
        const res = await fetch(`${url}/health`);
        if (res.ok) return;
      } catch {
        // server not ready yet
      }
      await new Promise((r) => setTimeout(r, this.healthCheckDelayMs));
    }
    if (this.spawnedProcess) {
      this.spawnedProcess.kill();
      this.spawnedProcess = null;
    }
    throw new Error("Local server failed to start within 5s");
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;

    for (const interval of this.heartbeatIntervals.values()) {
      clearInterval(interval);
    }
    this.heartbeatIntervals.clear();

    if (this.sdk) {
      for (const instanceId of this.activeInstances) {
        try {
          await this.sdk.deleteInstance(instanceId);
        } catch {
          // best-effort cleanup
        }
      }
    }
    this.activeInstances.clear();

    if (this.spawnedProcess) {
      this.spawnedProcess.kill();
      this.spawnedProcess = null;
    }

    this.removeCleanupHandlers();
    this.sdk = null;
    this.connected = false;
  }
}
