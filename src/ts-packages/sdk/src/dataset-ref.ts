import { ApiClient } from "./api-client.js";
import { Instance } from "./instance.js";
import type { AgentifiedTool, RegisterInput } from "./types.js";

function validateTools(tools: AgentifiedTool[]): void {
  for (const tool of tools) {
    if ("type" in tool && tool.type === "client") {
      throw new Error("Client tools are not yet supported");
    }
    if (!("handler" in tool)) {
      throw new Error(`Tool '${(tool as { name: string }).name}' has no type and no handler`);
    }
  }
}

export class DatasetRef {
  constructor(
    /** @internal */ protected readonly _agentified: { sdk: ApiClient | null; serverUrl: string | null },
    readonly datasetName: string,
  ) {}

  async register(input: RegisterInput): Promise<Instance> {
    validateTools(input.tools);

    const sdk = this._agentified.sdk;
    if (!sdk) throw new Error("Not connected");

    const serverTools = input.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      ...("type" in t && t.type === "mcp" ? { type: "mcp", server_uri: t.server } : {}),
    }));
    // Separate ApiClient for registration: it must carry the tool list,
    // while the shared SDK instance is tool-agnostic.
    const regSdk = new ApiClient({
      serverUrl: this._agentified.serverUrl!,
      tools: serverTools,
    });
    await regSdk.register(this.datasetName);

    return new Instance(this.datasetName, this.datasetName, sdk, input.tools);
  }
}
