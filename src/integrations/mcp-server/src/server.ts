import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  type ExecutableTool,
  formatUpstreamLine,
  invokeToolTool,
  searchToolsTool,
  type ToolCatalog,
  type UpstreamServerInfo,
} from "@ratel-ai/sdk";

export interface CreateMcpServerOptions {
  name: string;
  version: string;
  transport: Transport;
  upstreamServers?: readonly UpstreamServerInfo[];
}

export interface McpServerHandle {
  close: () => Promise<void>;
}

export async function createMcpServer(
  catalog: ToolCatalog,
  options: CreateMcpServerOptions,
): Promise<McpServerHandle> {
  const { name, version, transport, upstreamServers } = options;

  const gateway: Record<string, ExecutableTool> = {};
  for (const tool of [searchToolsTool(catalog, { upstreamServers }), invokeToolTool(catalog)]) {
    gateway[tool.name] = tool;
  }

  const server = new Server(
    { name, version },
    {
      capabilities: { tools: {} },
      instructions: buildServerInstructions(upstreamServers),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.values(gateway).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as { [k: string]: unknown; type: "object" },
      ...(isObjectSchema(tool.outputSchema)
        ? { outputSchema: tool.outputSchema as { [k: string]: unknown; type: "object" } }
        : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = gateway[req.params.name];
    if (!tool) {
      throw new Error(`unknown gateway tool: ${req.params.name}`);
    }
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const out = await tool.execute(args);
    return wrapResult(out);
  });

  await server.connect(transport);

  return {
    close: async () => {
      await server.close();
    },
  };
}

function buildServerInstructions(upstreams?: readonly UpstreamServerInfo[]): string {
  const base =
    "This is the Ratel context-engineering gateway. Before reaching for any built-in capability " +
    "(web fetch, shell, search, automation, etc.), call `search_tools` first — Ratel may have a " +
    "purpose-built tool registered for the task. If `search_tools` returns a relevant hit, run it " +
    "via `invoke_tool` instead of falling back to a generic capability.";
  if (!upstreams || upstreams.length === 0) return base;
  const list = upstreams.map(formatUpstreamLine).join("\n");
  return `${base}\n\nThis catalog aggregates tools from these upstream MCP servers:\n${list}`;
}

function isObjectSchema(schema: unknown): boolean {
  // MCP requires outputSchema (when set) to be a JSON Schema with `type: "object"`.
  // `search_tools` returns an array; its array-typed schema must be omitted at this boundary.
  return (
    typeof schema === "object" &&
    schema !== null &&
    (schema as { type?: unknown }).type === "object"
  );
}

function wrapResult(out: unknown) {
  const text = JSON.stringify(out);
  const isPlainObject = out !== null && typeof out === "object" && !Array.isArray(out);
  return {
    content: [{ type: "text" as const, text }],
    ...(isPlainObject ? { structuredContent: out as Record<string, unknown> } : {}),
  };
}
