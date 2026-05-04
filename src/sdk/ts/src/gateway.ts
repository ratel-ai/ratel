import type { ExecutableTool, ToolCatalog } from "./catalog.js";

export const SEARCH_TOOLS_ID = "search_tools" as const;
export const INVOKE_TOOL_ID = "invoke_tool" as const;

const SEARCH_TOOLS_BASE_DESCRIPTION =
  "Search the catalog of available tools by natural-language query. " +
  "Returns the most relevant tool ids with their descriptions and input schemas. " +
  "Use this to discover tools that aren't in your direct tool list, then run them via invoke_tool.";

export interface UpstreamServerInfo {
  name: string;
  description?: string;
  toolCount?: number;
}

export interface SearchToolsToolOptions {
  upstreamServers?: readonly UpstreamServerInfo[];
}

export function formatUpstreamLine(s: UpstreamServerInfo): string {
  let line = `- ${s.name}`;
  if (s.description) line += ` — ${s.description}`;
  if (typeof s.toolCount === "number") line += ` (${s.toolCount} tools)`;
  return line;
}

function buildSearchToolsDescription(opts?: SearchToolsToolOptions): string {
  const upstreams = opts?.upstreamServers ?? [];
  if (upstreams.length === 0) return SEARCH_TOOLS_BASE_DESCRIPTION;
  const list = upstreams.map(formatUpstreamLine).join("\n");
  return `${SEARCH_TOOLS_BASE_DESCRIPTION}\n\nThis catalog aggregates tools from these upstream MCP servers:\n${list}`;
}

export function searchToolsTool(
  catalog: ToolCatalog,
  opts?: SearchToolsToolOptions,
): ExecutableTool {
  return {
    id: SEARCH_TOOLS_ID,
    name: SEARCH_TOOLS_ID,
    description: buildSearchToolsDescription(opts),
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "describe what you want to do" },
        topK: { type: "number", description: "max number of tool ids to return (default 5)" },
      },
      required: ["query"],
    },
    outputSchema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          toolId: { type: "string" },
          score: { type: "number" },
          description: { type: "string" },
          inputSchema: { type: "object" },
        },
      },
    },
    execute: async (input) => {
      const { query, topK } = input as { query: string; topK?: number };
      const hits = catalog.search(query, topK ?? 5);
      return hits.map((h) => ({
        toolId: h.toolId,
        score: h.score,
        description: catalog.get(h.toolId)?.description ?? "",
        inputSchema: catalog.get(h.toolId)?.inputSchema ?? {},
      }));
    },
  };
}

export function invokeToolTool(catalog: ToolCatalog): ExecutableTool {
  return {
    id: INVOKE_TOOL_ID,
    name: INVOKE_TOOL_ID,
    description:
      "Invoke a tool from the catalog by its id. Use this to call tools that aren't in your direct tool list — " +
      "first find one via search_tools, then run it here. " +
      "Pass the tool's arguments nested under the `args` field — do NOT flatten them to the top level.",
    inputSchema: {
      type: "object",
      properties: {
        toolId: {
          type: "string",
          description: "id of the tool to invoke (use search_tools to find available ids)",
        },
        args: {
          type: "object",
          description:
            "arguments object matching the tool's inputSchema, nested as a single object",
          additionalProperties: true,
        },
      },
      required: ["toolId", "args"],
    },
    outputSchema: { type: "object" },
    execute: async (input) => {
      const inputObj = input as Record<string, unknown>;
      const toolId = inputObj.toolId as string;
      if (!catalog.has(toolId)) {
        return {
          error: `unknown toolId: ${toolId}. Use search_tools to discover available ids.`,
        };
      }
      const nested = inputObj.args;
      const args =
        nested && typeof nested === "object" && !Array.isArray(nested)
          ? (nested as Record<string, unknown>)
          : Object.fromEntries(Object.entries(inputObj).filter(([k]) => k !== "toolId"));
      try {
        return await catalog.invoke(toolId, args);
      } catch (err) {
        return { error: `tool ${toolId} threw: ${(err as Error).message}` };
      }
    },
  };
}
