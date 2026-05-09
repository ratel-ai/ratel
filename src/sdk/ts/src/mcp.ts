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
  const transportLabel = transportKind(transport);

  const { tools } = await client.listTools();
  catalog.recordEvent({
    type: "upstream_register",
    server: name,
    transport: transportLabel,
    tool_count: tools.length,
  });
  const toolIds: string[] = [];
  for (const tool of tools) {
    const id = `${name}__${tool.name}`;
    catalog.register({
      id,
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema ?? { type: "object" },
      execute: async (args) => {
        const startedAt = Date.now();
        try {
          const result = await client.callTool({
            name: tool.name,
            arguments: args as Record<string, unknown>,
          });
          catalog.recordEvent({
            type: "upstream_invoke",
            server: name,
            tool_id: id,
            took_ms: Date.now() - startedAt,
          });
          return result;
        } catch (err) {
          catalog.recordEvent({
            type: "upstream_error",
            server: name,
            tool_id: id,
            error: (err as Error).message ?? String(err),
          });
          throw err;
        }
      },
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

function transportKind(transport: Transport): string {
  const ctor = (transport as { constructor?: { name?: string } }).constructor;
  return ctor?.name ?? "unknown";
}
