import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpTool } from "./types.js";

export interface McpToolsOptions {
  server: string;
}

const clientCache = new Map<string, Client>();

export async function mcpTools(options: McpToolsOptions): Promise<McpTool[]> {
  const { server } = options;
  let client = clientCache.get(server);
  if (!client) {
    client = new Client({ name: "agentified", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(server)));
    clientCache.set(server, client);
  }

  const allTools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    allTools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);

  return allTools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    parameters: (t.inputSchema ?? {}) as Record<string, unknown>,
    type: "mcp" as const,
    server,
    handler: async (args: Record<string, unknown>) => {
      try {
        return await client!.callTool({ name: t.name, arguments: args });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: `MCP tool '${t.name}' failed: ${message}` }],
        };
      }
    },
  }));
}

/** @internal test-only */
export function _resetClientCache(): void {
  clientCache.clear();
}
