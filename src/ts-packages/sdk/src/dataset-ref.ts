import { ApiClient } from "./api-client.js";
import { Instance } from "./instance.js";
import type { AgentifiedTool, RegisterInput } from "./types.js";

function validateTools(tools: AgentifiedTool[]): void {
  for (const tool of tools) {
    if ("type" in tool && tool.type === "client") {
      throw new Error("Client tools are not yet supported");
    }
    if ("type" in tool && tool.type === "mcp") {
      throw new Error("MCP tools are not yet supported");
    }
    if (!("handler" in tool)) {
      throw new Error(`Tool '${(tool as { name: string }).name}' has no type and no handler`);
    }
  }
}

export class DatasetRef {
  constructor(
    /** @internal */ readonly _agentified: { sdk: ApiClient | null; serverUrl: string | null },
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
    }));
    const regSdk = new ApiClient({
      serverUrl: this._agentified.serverUrl!,
      tools: serverTools,
    });
    await regSdk.register(this.datasetName);

    const toolNames = input.tools.map((t) => t.name);
    return new Instance(this.datasetName, this.datasetName, sdk, toolNames);
  }
}
