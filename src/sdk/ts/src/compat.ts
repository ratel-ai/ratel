/**
 * Backward-compatibility shims for the pre-0.2.0 capability-tools surface.
 *
 * 0.2.0 renamed `search_tools` → `search_capabilities` and changed its result
 * shape from `{ groups }` to `{ tools: { groups }, skills }`. To keep code
 * written against `@ratel-ai/sdk@0.1.x` working after an upgrade, the old
 * `searchToolsTool` / `SEARCH_TOOLS_ID` (and their result types) are preserved
 * here **with their original behaviour** — a tools-only `{ groups }` result and
 * the `search_tools` id — not aliased to the new two-bucket tool.
 *
 * @deprecated These are temporary. Migrate to `searchCapabilitiesTool` /
 * `SEARCH_CAPABILITIES_ID` (see capabilities.ts). Tracked for removal in RAT-250.
 */

import { formatUpstreamLine, type UpstreamServerInfo } from "./capabilities.js";
import type { ExecutableTool, ToolCatalog } from "./catalog.js";

/** @deprecated Use `SEARCH_CAPABILITIES_ID` (`"search_capabilities"`). */
export const SEARCH_TOOLS_ID = "search_tools" as const;

const SEARCH_TOOLS_BASE_DESCRIPTION =
  "Discover tools beyond the ones already visible in your direct tool list. " +
  "Call this BEFORE refusing a request, falling back to a generic capability " +
  "(web fetch, shell, built-in search), or deciding none of the visible tools " +
  "fits — a purpose-built tool may be in the catalog but not pre-loaded. " +
  "Pass a natural-language query describing what you want to do; you'll get " +
  "back the most relevant tool ids with their descriptions and input schemas. " +
  "Then run the chosen one via invoke_tool.";

/** @deprecated Use `SearchCapabilitiesOptions`. */
export interface SearchToolsToolOptions {
  upstreamServers?: readonly UpstreamServerInfo[];
}

/** @deprecated Use `CapabilityToolHit`. */
export interface SearchToolHit {
  toolId: string;
  score: number;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** @deprecated Use `CapabilityToolGroup`. */
export interface SearchToolsGroup {
  server: { name: string; description?: string; instructions?: string };
  hits: SearchToolHit[];
}

/** @deprecated Use `SearchCapabilitiesResult` (the `tools.groups` field). */
export interface SearchToolsResult {
  groups: SearchToolsGroup[];
}

function buildSearchToolsDescription(opts?: SearchToolsToolOptions): string {
  const upstreams = opts?.upstreamServers ?? [];
  if (upstreams.length === 0) return SEARCH_TOOLS_BASE_DESCRIPTION;
  const list = upstreams.map(formatUpstreamLine).join("\n");
  return `${SEARCH_TOOLS_BASE_DESCRIPTION}\n\nThis catalog aggregates tools from these upstream MCP servers:\n${list}`;
}

/**
 * The pre-0.2.0 tools-only discovery tool, preserved verbatim (id `search_tools`,
 * `{ groups }` result, `topK` input). New code should use
 * {@link searchCapabilitiesTool}, which additionally returns a reserved `skills`
 * bucket. Registering both lets a host serve the old and new names during a
 * migration window.
 *
 * @deprecated Use `searchCapabilitiesTool`. Tracked for removal in RAT-250.
 */
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
        topK: {
          type: "integer",
          minimum: 1,
          description: "max number of tool ids to return (default 5)",
        },
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
      const k = typeof topK === "number" && Number.isInteger(topK) && topK >= 1 ? topK : 5;
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
      return result;
    },
  };
}
