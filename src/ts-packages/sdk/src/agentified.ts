import { ApiClient } from "./api-client.js";
import { DatasetRef } from "./dataset-ref.js";
import { Instance } from "./instance.js";
import { resolveBinaryPath, findFreePort } from "./spawn-utils.js";
import type { RegisterInput, SearchStrategy } from "./types.js";
import { spawn, type ChildProcess } from "node:child_process";

export class Agentified {
  /** @internal */ sdk: ApiClient | null = null;
  /** @internal */ serverUrl: string | null = null;
  private connected = false;
  private spawnedProcess: ChildProcess | null = null;
  private cleanupHandlers: Array<[string, (...args: any[]) => void]> = [];
  private restartCount = 0;
  private spawnArgs: { binaryPath: string; port: number } | null = null;
  private headers?: Record<string, string>;
  private strategy?: SearchStrategy;

  async connect(serverUrl?: string, options?: { headers?: Record<string, string>; strategy?: SearchStrategy }): Promise<void> {
    if (this.connected) throw new Error("Already connected");
    this.headers = options?.headers;
    this.strategy = options?.strategy;
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

      this.serverUrl = url;
      this.sdk = new ApiClient({ serverUrl: url, tools: [], headers: this.headers, strategy: this.strategy });
      this.connected = true;
      return;
    }

    const res = await fetch(`${serverUrl}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
      ...(this.headers ? { headers: this.headers } : {}),
    });
    if (!res.ok) {
      throw new Error(`Health check failed: ${res.status}`);
    }

    this.serverUrl = serverUrl;
    this.sdk = new ApiClient({ serverUrl, tools: [], headers: this.headers, strategy: this.strategy });
    this.connected = true;
  }

  adaptTo<T>(adapter: { adapt: (ag: Agentified) => T }): T {
    return adapter.adapt(this);
  }

  dataset(name: string): DatasetRef {
    return new DatasetRef(this, name);
  }

  async register(input: RegisterInput): Promise<Instance> {
    return this.dataset("default").register(input);
  }

  private spawnChild(): void {
    if (!this.spawnArgs) return;
    const { binaryPath, port } = this.spawnArgs;
    const child = spawn(binaryPath, [], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AGENTIFIED_PORT: String(port) },
    });
    this.spawnedProcess = child;
  }

  private registerCrashHandler(): void {
    if (!this.spawnedProcess) return;
    this.spawnedProcess.on("exit", (_code, _signal) => {
      if (!this.connected) return;
      if (this.restartCount >= 1) return;
      this.restartCount++;
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
        const res = this.headers
          ? await fetch(`${url}/health`, { headers: this.headers })
          : await fetch(`${url}/health`);
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

    if (this.spawnedProcess) {
      this.spawnedProcess.kill();
      this.spawnedProcess = null;
    }

    this.removeCleanupHandlers();
    this.sdk = null;
    this.serverUrl = null;
    this.connected = false;
  }
}
