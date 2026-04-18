import type { ApiClient } from "./api-client.js";
import type { ObserverEmitter } from "./events.js";
import { Namespace } from "./namespace.js";
import { Session } from "./session.js";
import type { AgentifiedTool, DiscoverTool, PrepareStepFn } from "./types.js";

export class Instance {
  readonly discoverTool: DiscoverTool;

  constructor(
    readonly instanceId: string,
    readonly datasetId: string,
    /** @internal */ private readonly sdk: ApiClient,
    /** @internal */ private readonly registeredTools: AgentifiedTool[],
    /** @internal */ readonly emitter?: ObserverEmitter,
  ) {
    this.discoverTool = sdk.asDiscoverTool(datasetId);
  }

  readonly prepareStep: PrepareStepFn = async () => {
    const activeTools = new Set(["agentified_discover", ...this.discoverTool.discoveredNames]);
    return { activeTools: [...activeTools] };
  };

  session(id: string): Session {
    return new Session(id, "default", this.sdk, this.datasetId, this.registeredTools, this.emitter);
  }

  namespace(id: string): Namespace {
    return new Namespace(id, this.sdk, this.datasetId, this.registeredTools, this.emitter);
  }
}
