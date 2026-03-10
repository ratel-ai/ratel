import { ApiClient } from "@agentified/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { resolveBinaryPath, findFreePort } from "./spawn-utils.js";

export interface BackendTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  type?: "backend";
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface ClientTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  type: "client";
}

export interface McpTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  type: "mcp";
  server: string;
}

export type AgentifiedTool = BackendTool | ClientTool | McpTool;

export interface RegisterInput {
  tools: AgentifiedTool[];
}

export class Instance {
  constructor(
    readonly instanceId: string,
    readonly datasetId: string,
  ) {}
}

function validateTools(tools: AgentifiedTool[]): void {
  for (const tool of tools) {
    if (!("handler" in tool) && !("type" in tool && tool.type)) {
      throw new Error(`Tool '${tool.name}' has no type and no handler`);
    }
    if ("type" in tool && tool.type === "client") {
      throw new Error("Client tools are not yet supported");
    }
    if ("type" in tool && tool.type === "mcp") {
      throw new Error("MCP tools are not yet supported");
    }
  }
}

export class DatasetRef {
  constructor(
    readonly agentified: Agentified,
    readonly datasetName: string,
  ) {}

  async register(input: RegisterInput): Promise<Instance> {
    validateTools(input.tools);

    const sdk = this.agentified.sdk;
    if (!sdk) throw new Error("Not connected");

    const { instanceId } = await sdk.createInstance(this.datasetName);

    try {
      const serverTools = input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
      const regSdk = new ApiClient({
        serverUrl: this.agentified.serverUrl!,
        tools: serverTools,
      });
      await regSdk.register(instanceId);
    } catch (err) {
      await sdk.deleteInstance(instanceId);
      throw err;
    }

    const interval = setInterval(() => {
      sdk.heartbeatInstance(instanceId).catch(() => {});
    }, 30_000);
    this.agentified.heartbeatIntervals.set(instanceId, interval);
    this.agentified.activeInstances.add(instanceId);

    return new Instance(instanceId, this.datasetName);
  }
}

export class Agentified {
  /** @internal */ sdk: ApiClient | null = null;
  /** @internal */ serverUrl: string | null = null;
  private connected = false;
  private spawnedProcess: ChildProcess | null = null;
  /** @internal */ activeInstances: Set<string> = new Set();
  /** @internal */ heartbeatIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();
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

      this.serverUrl = url;
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

    this.serverUrl = serverUrl;
    this.sdk = new ApiClient({ serverUrl, tools: [] });
    this.connected = true;
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
    this.serverUrl = null;
    this.connected = false;
  }
}
