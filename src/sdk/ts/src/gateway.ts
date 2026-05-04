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
  instructions?: string;
  toolCount?: number;
}

export interface SearchToolsToolOptions {
  upstreamServers?: readonly UpstreamServerInfo[];
}

export interface SearchToolHit {
  toolId: string;
  score: number;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface SearchToolsGroup {
  server: { name: string; description?: string; instructions?: string };
  hits: SearchToolHit[];
}

export interface SearchToolsResult {
  groups: SearchToolsGroup[];
}

const MAX_DESCRIPTION_LEN = 160;

export function formatUpstreamLine(s: UpstreamServerInfo): string {
  let line = `- ${s.name}`;
  if (s.description) line += ` — ${compactDescription(s.description)}`;
  if (typeof s.toolCount === "number") line += ` (${s.toolCount} tools)`;
  return line;
}

function compactDescription(s: string): string {
  const collapsed = s.trim().replace(/\s+/g, " ");
  if (collapsed.length <= MAX_DESCRIPTION_LEN) return collapsed;
  const cut = collapsed.slice(0, MAX_DESCRIPTION_LEN - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const head = lastSpace > 80 ? cut.slice(0, lastSpace) : cut;
  return `${head.trimEnd()}…`;
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
  const upstreams = opts?.upstreamServers ?? [];
  const upstreamByName = new Map(upstreams.map((u) => [u.name, u]));
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
      type: "object",
      properties: {
        groups: {
          type: "array",
          items: {
            type: "object",
            properties: {
              server: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  description: { type: "string" },
                  instructions: { type: "string" },
                },
                required: ["name"],
              },
              hits: {
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
            },
            required: ["server", "hits"],
          },
        },
      },
      required: ["groups"],
    },
    execute: async (input) => {
      const { query, topK } = input as { query: string; topK?: number };
      const hits = catalog.search(query, topK ?? 5);
      const order: string[] = [];
      const groups = new Map<string, SearchToolsGroup>();
      for (const h of hits) {
        const sep = h.toolId.indexOf("__");
        const serverName = sep > 0 ? h.toolId.slice(0, sep) : h.toolId;
        let group = groups.get(serverName);
        if (!group) {
          const meta = upstreamByName.get(serverName);
          group = {
            server: {
              name: serverName,
              ...(meta?.description ? { description: meta.description } : {}),
              ...(meta?.instructions ? { instructions: meta.instructions } : {}),
            },
            hits: [],
          };
          groups.set(serverName, group);
          order.push(serverName);
        }
        const tool = catalog.get(h.toolId);
        group.hits.push({
          toolId: h.toolId,
          score: h.score,
          description: tool?.description ?? "",
          inputSchema: (tool?.inputSchema ?? {}) as Record<string, unknown>,
        });
      }
      const result: SearchToolsResult = {
        // biome-ignore lint/style/noNonNullAssertion: order entries are guaranteed by construction
        groups: order.map((n) => groups.get(n)!),
      };
      return result;
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
