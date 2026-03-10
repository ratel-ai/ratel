import {
  Agentified as SdkAgentified,
  Instance as SdkInstance,
  DatasetRef as SdkDatasetRef,
  ApiClient,
  type DiscoverToolInput,
  type RegisterInput,
} from "agentified";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

// Re-export SDK classes that need no Mastra extensions
export {
  Session,
  Namespace,
  ContextBuilder,
  Conversation,
} from "agentified";

export type {
  AgentifiedTool,
  BackendTool,
  ClientTool,
  McpTool,
  RegisterInput,
  PrepareStepFn,
  AssembledContext,
  GetMessagesOptions,
  GetMessagesResult,
} from "agentified";

/**
 * Mastra-specific Instance: wraps discoverTool with createTool.
 */
export class Instance extends SdkInstance {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override readonly discoverTool: any;

  constructor(
    instanceId: string,
    datasetId: string,
    /** @internal */ sdk: ApiClient,
    /** @internal */ toolNames: string[],
  ) {
    super(instanceId, datasetId, sdk, toolNames);
    const discoverDef = sdk.asDiscoverTool(datasetId);
    this.discoverTool = createTool({
      id: "agentified_discover",
      description: discoverDef.definition.description,
      inputSchema: z.object({ query: z.string(), limit: z.number().optional() }),
      execute: async (input) => {
        return discoverDef.execute(input as DiscoverToolInput);
      },
    });
  }
}

/**
 * Mastra-specific DatasetRef: returns Mastra Instance on register.
 */
export class DatasetRef extends SdkDatasetRef {
  override async register(input: RegisterInput): Promise<Instance> {
    const sdkInstance = await super.register(input);
    const sdk = this._agentified.sdk;
    if (!sdk) throw new Error("Not connected");
    return new Instance(
      sdkInstance.instanceId,
      sdkInstance.datasetId,
      sdk,
      input.tools.map((t) => t.name),
    );
  }
}

/**
 * Mastra-specific Agentified: returns Mastra DatasetRef/Instance.
 */
export class Agentified extends SdkAgentified {
  override dataset(name: string): DatasetRef {
    return new DatasetRef(this, name);
  }

  override async register(input: RegisterInput): Promise<Instance> {
    return this.dataset("default").register(input);
  }
}
