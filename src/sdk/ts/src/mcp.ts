import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { ToolCatalog } from "./catalog.js";

export interface RegisterMcpServerOptions {
  name: string;
  transport: Transport;
}

export interface McpServerHandle {
  toolIds: string[];
  serverInstructions: string | undefined;
  close: () => Promise<void>;
}

export async function registerMcpServer(
  catalog: ToolCatalog,
  options: RegisterMcpServerOptions,
): Promise<McpServerHandle> {
  const { name, transport } = options;

  const client = new Client({ name: "@ratel-ai/sdk", version: "0.0.0" });
  await client.connect(transport);

  const serverInstructions = client.getInstructions();

  const { tools } = await client.listTools();
  const toolIds: string[] = [];
  for (const tool of tools) {
    const id = `${name}__${tool.name}`;
    catalog.register({
      id,
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema ?? { type: "object" },
      execute: async (args) =>
        client.callTool({
          name: tool.name,
          arguments: args as Record<string, unknown>,
        }),
    });
    toolIds.push(id);
  }

  return {
    toolIds,
    serverInstructions,
    close: async () => {
      await client.close();
    },
  };
}
