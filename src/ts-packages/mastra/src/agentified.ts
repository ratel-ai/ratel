import { ApiClient } from "@agentified/sdk";
import type { ChildProcess } from "node:child_process";

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

  async connect(serverUrl?: string): Promise<void> {
    if (!serverUrl) {
      throw new Error("Local spawn not yet implemented");
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

    this.sdk = null;
    this.connected = false;
  }
}
