import type { ApiClient } from "./api-client.js";
import { Namespace } from "./namespace.js";
import { Session } from "./session.js";
import type { DiscoverTool, PrepareStepFn } from "./types.js";

export class Instance {
  readonly discoverTool: DiscoverTool;

  constructor(
    readonly instanceId: string,
    readonly datasetId: string,
    /** @internal */ private readonly sdk: ApiClient,
    /** @internal */ private readonly toolNames: string[],
  ) {
    this.discoverTool = sdk.asDiscoverTool(datasetId);
  }

  readonly prepareStep: PrepareStepFn = async ({ steps }) => {
    const activeTools = new Set([...this.toolNames, "agentified_discover"]);

    for (const step of steps) {
      if (step.toolResults) {
        for (const result of step.toolResults) {
          if (result.toolName === "agentified_discover" && Array.isArray(result.result)) {
            for (const tool of result.result) {
              if (tool.name) activeTools.add(tool.name);
            }
          }
        }
      }
    }

    return { activeTools: [...activeTools] };
  };

  session(id: string): Session {
    return new Session(id, "default", this.sdk, this.datasetId, this.toolNames);
  }

  namespace(id: string): Namespace {
    return new Namespace(id, this.sdk, this.datasetId, this.toolNames);
  }
}
