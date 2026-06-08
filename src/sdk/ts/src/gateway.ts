import type { ExecutableTool, ToolCatalog } from "./catalog.js";
import { compactDescription } from "./compact.js";
import type { SkillCatalog } from "./skill-catalog.js";
import { type RelatedSkill, relatedSkillsFor } from "./skill-gateway.js";

export const SEARCH_TOOLS_ID = "search_tools" as const;
export const INVOKE_TOOL_ID = "invoke_tool" as const;

const SEARCH_TOOLS_BASE_DESCRIPTION =
  "Discover tools beyond the ones already visible in your direct tool list. " +
  "Call this BEFORE refusing a request, falling back to a generic capability " +
  "(web fetch, shell, built-in search), or deciding none of the visible tools " +
  "fits — a purpose-built tool may be in the catalog but not pre-loaded. " +
  "Pass a natural-language query describing what you want to do; you'll get " +
  "back the most relevant tool ids with their descriptions and input schemas. " +
  "Then run the chosen one via invoke_tool.";

export interface UpstreamServerInfo {
  name: string;
  description?: string;
  instructions?: string;
  toolCount?: number;
  /** True when the upstream rejected its boot connection with 401 / requires re-authorization. */
  needsAuth?: boolean;
}

export interface SearchToolsToolOptions {
  upstreamServers?: readonly UpstreamServerInfo[];
  /** When set, search_tools also returns skills relevant to the query. */
  skillCatalog?: SkillCatalog;
  /** Max related skills to attach (default 2). */
  relatedSkillsLimit?: number;
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
  /** Skills relevant to the query — present only when a skill catalog is wired and matches. */
  relatedSkills?: RelatedSkill[];
}

export function formatUpstreamLine(s: UpstreamServerInfo): string {
  let line = `- ${s.name}`;
  if (s.description) line += ` — ${compactDescription(s.description)}`;
  if (typeof s.toolCount === "number") line += ` (${s.toolCount} tools)`;
  if (s.needsAuth) line += " (auth required)";
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
        relatedSkills: {
          type: "array",
          items: {
            type: "object",
            properties: {
              skillId: { type: "string" },
              description: { type: "string" },
              hint: { type: "string" },
            },
            required: ["skillId", "description", "hint"],
          },
        },
      },
      required: ["groups"],
    },
    execute: async (input) => {
      const { query, topK } = input as { query: string; topK?: number };
      const k = topK ?? 5;
      const startedAt = Date.now();
      const hits = catalog.search(query, k, "agent");
      catalog.recordEvent({
        type: "gateway_search",
        query,
        origin: "agent",
        top_k: k,
        hits: hits.length,
        took_ms: Date.now() - startedAt,
      });
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
      if (opts?.skillCatalog) {
        const related = relatedSkillsFor(opts.skillCatalog, query, {
          limit: opts.relatedSkillsLimit,
        });
        if (related.length > 0) result.relatedSkills = related;
      }
      return result;
    },
  };
}

export interface InvokeToolToolOptions {
  /** Notified when the underlying tool throws UnauthorizedError, with the upstream name inferred from the toolId. */
  onUnauthorized?: (upstream: string) => void | Promise<void>;
  /** When set, a successful invoke also suggests skills relevant to the tool. */
  skillCatalog?: SkillCatalog;
  /** Max related skills to attach (default 2). */
  relatedSkillsLimit?: number;
}

export function invokeToolTool(
  catalog: ToolCatalog,
  opts: InvokeToolToolOptions = {},
): ExecutableTool {
  return {
    id: INVOKE_TOOL_ID,
    name: INVOKE_TOOL_ID,
    description:
      "Invoke a tool from the catalog by its id. Use this to call tools that aren't in your direct tool list — " +
      "first find one via search_tools, then run it here. " +
      "Pass the tool's arguments nested under the `args` field — do NOT flatten them to the top level. " +
      "If the response is shaped `{ result, relatedSkills }`, the tool output is under `result` and a " +
      "purpose-built skill is suggested — load it with invoke_skill before continuing.",
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
        catalog.recordEvent({
          type: "gateway_error",
          tool_id: toolId,
          error: "unknown_tool_id",
        });
        return {
          error: `unknown toolId: ${toolId}. Use search_tools to discover available ids.`,
        };
      }
      const nested = inputObj.args;
      const args =
        nested && typeof nested === "object" && !Array.isArray(nested)
          ? (nested as Record<string, unknown>)
          : Object.fromEntries(Object.entries(inputObj).filter(([k]) => k !== "toolId"));
      const startedAt = Date.now();
      try {
        const result = await catalog.invoke(toolId, args);
        catalog.recordEvent({
          type: "gateway_invoke",
          tool_id: toolId,
          took_ms: Date.now() - startedAt,
        });
        if (opts.skillCatalog) {
          const related = relatedSkillsFor(opts.skillCatalog, skillQueryForTool(catalog, toolId), {
            limit: opts.relatedSkillsLimit,
          });
          // Wrap only when there's a skill to recommend; otherwise return the raw
          // result unchanged so existing callers see no difference.
          if (related.length > 0) return { result, relatedSkills: related };
        }
        return result;
      } catch (err) {
        if (isUnauthorizedError(err)) {
          const upstream = upstreamFromToolId(toolId);
          if (upstream && opts.onUnauthorized) {
            await opts.onUnauthorized(upstream);
          }
          catalog.recordEvent({
            type: "gateway_error",
            tool_id: toolId,
            error: "needs_auth",
          });
          const payload: { error: string; upstream?: string; hint: string } = {
            error: "needs_auth",
            hint: `call the auth tool to re-authorize${upstream ? ` ${upstream}` : ""}`,
          };
          if (upstream) payload.upstream = upstream;
          return payload;
        }
        catalog.recordEvent({
          type: "gateway_error",
          tool_id: toolId,
          error: (err as Error).message ?? String(err),
        });
        return { error: `tool ${toolId} threw: ${(err as Error).message}` };
      }
    },
  };
}

function isUnauthorizedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "UnauthorizedError";
}

function upstreamFromToolId(toolId: string): string | undefined {
  const idx = toolId.indexOf("__");
  if (idx <= 0) return undefined;
  return toolId.slice(0, idx);
}

/**
 * Build the skill-search query for a just-invoked tool: the upstream server
 * name and tool name (the `server__tool` id with the separator as a space),
 * plus the tool's own description — so "vercel__deploy" surfaces Vercel skills.
 */
function skillQueryForTool(catalog: ToolCatalog, toolId: string): string {
  const idParts = toolId.replace("__", " ");
  const description = catalog.get(toolId)?.description ?? "";
  return `${idParts} ${description}`.trim();
}
