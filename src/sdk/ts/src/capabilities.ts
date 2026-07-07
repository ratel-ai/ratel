import type { ExecutableTool, ToolCatalog } from "./catalog.js";
import { compactDescription } from "./compact.js";
import type { SkillCatalog } from "./skill-catalog.js";
import { recordAuthNeeded, upstreamFromToolId } from "./telemetry.js";

export const SEARCH_CAPABILITIES_ID = "search_capabilities" as const;
export const INVOKE_TOOL_ID = "invoke_tool" as const;

const DEFAULT_TOP_K_TOOLS = 5;
const DEFAULT_TOP_K_SKILLS = 3;
const MAX_TOP_K = 50;

/**
 * Clamp a model-supplied top-K to a positive integer in [1, MAX_TOP_K], falling
 * back to `fallback` for anything else (undefined, 0, negative, non-integer,
 * NaN). Tools and skills — and the TS and Python SDKs — run the same input
 * through this, so a stray `topK` can't silently return zero results (or, via a
 * negative wrapping to u32 in the native layer, an unbounded set).
 */
function clampTopK(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, MAX_TOP_K);
}

// The discovery prompt the model sees. The skills clause is only included when a
// non-empty skill catalog is wired in — otherwise the tool would advertise a
// `skills` bucket and `get_skill_content` that don't exist (the result would
// always be `skills: []`).
const SEARCH_INTRO =
  "Discover capabilities beyond the ones already in your direct tool list. Call this BEFORE refusing " +
  "a request, falling back to a generic capability (web fetch, shell, built-in search), or improvising " +
  "a multi-step task: a purpose-built capability may be in the catalog but not pre-loaded. Pass a " +
  "natural-language query describing what you want to do.";
const RESULT_TOOLS_ONLY = " You get back a `tools` bucket (executable) — run one via invoke_tool.";
const RESULT_TOOLS_AND_SKILLS =
  " You get back two independent buckets: `tools` (run one via invoke_tool) and `skills` (reusable " +
  "playbooks — load one's instructions via get_skill_content, then follow it). Skills have their own " +
  "result budget, so they are never crowded out by tools.";

export interface UpstreamServerInfo {
  name: string;
  description?: string;
  instructions?: string;
  toolCount?: number;
  /** True when the upstream rejected its boot connection with 401 / requires re-authorization. */
  needsAuth?: boolean;
}

export interface SearchCapabilitiesOptions {
  upstreamServers?: readonly UpstreamServerInfo[];
}

export interface CapabilityToolHit {
  toolId: string;
  score: number;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CapabilityToolGroup {
  server: { name: string; description?: string; instructions?: string };
  hits: CapabilityToolHit[];
}

export interface CapabilitySkillHit {
  skillId: string;
  score: number;
  description: string;
}

export interface SearchCapabilitiesResult {
  tools: { groups: CapabilityToolGroup[] };
  skills: CapabilitySkillHit[];
}

export function formatUpstreamLine(s: UpstreamServerInfo): string {
  let line = `- ${s.name}`;
  if (s.description) line += ` — ${compactDescription(s.description)}`;
  if (typeof s.toolCount === "number") line += ` (${s.toolCount} tools)`;
  if (s.needsAuth) line += " (auth required)";
  return line;
}

function buildSearchDescription(hasSkills: boolean, opts?: SearchCapabilitiesOptions): string {
  const base = SEARCH_INTRO + (hasSkills ? RESULT_TOOLS_AND_SKILLS : RESULT_TOOLS_ONLY);
  const upstreams = opts?.upstreamServers ?? [];
  if (upstreams.length === 0) return base;
  const list = upstreams.map(formatUpstreamLine).join("\n");
  return `${base}\n\nThis catalog aggregates tools from these upstream MCP servers:\n${list}`;
}

/**
 * Unified discovery over tools AND skills. Returns two independently-ranked
 * buckets, each with its own top-K budget — so a relevant skill can never be
 * starved out of the results by a large number of matching tools (and we avoid
 * comparing BM25 scores across the two different text shapes).
 */
export function searchCapabilitiesTool(
  toolCatalog: ToolCatalog,
  skillCatalog?: SkillCatalog,
  opts?: SearchCapabilitiesOptions,
): ExecutableTool {
  const upstreams = opts?.upstreamServers ?? [];
  const upstreamByName = new Map(upstreams.map((u) => [u.name, u]));
  const hasSkills = skillCatalog !== undefined && skillCatalog.size() > 0;
  return {
    id: SEARCH_CAPABILITIES_ID,
    name: SEARCH_CAPABILITIES_ID,
    description: buildSearchDescription(hasSkills, opts),
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "describe what you want to do" },
        topKTools: { type: "integer", minimum: 1, description: "max tools to return (default 5)" },
        topKSkills: {
          type: "integer",
          minimum: 1,
          description: "max skills to return (default 3)",
        },
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      properties: {
        tools: {
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
        skills: {
          type: "array",
          items: {
            type: "object",
            properties: {
              skillId: { type: "string" },
              score: { type: "number" },
              description: { type: "string" },
            },
            required: ["skillId", "score", "description"],
          },
        },
      },
      required: ["tools", "skills"],
    },
    execute: async (input) => {
      const { query, topKTools, topKSkills } = input as {
        query: string;
        topKTools?: number;
        topKSkills?: number;
      };
      const kTools = clampTopK(topKTools, DEFAULT_TOP_K_TOOLS);
      const kSkills = clampTopK(topKSkills, DEFAULT_TOP_K_SKILLS);
      const startedAt = Date.now();

      const toolHits = toolCatalog.search(query, kTools, "agent");
      toolCatalog.recordEvent({
        type: "gateway_search",
        query,
        origin: "agent",
        top_k: kTools,
        hits: toolHits.length,
        took_ms: Date.now() - startedAt,
      });

      const order: string[] = [];
      const groups = new Map<string, CapabilityToolGroup>();
      const seenTools = new Set<string>();
      // Add a tool to its server group, deduped. `score` is the BM25 query score
      // for a real match, or 0 for a skill-declared dependency (it rode in on the
      // skill, it was never matched by the query).
      const addTool = (toolId: string, score: number): void => {
        if (seenTools.has(toolId)) return;
        const tool = toolCatalog.get(toolId);
        if (!tool) return; // a declared id the catalog doesn't have: skip
        seenTools.add(toolId);
        const sep = toolId.indexOf("__");
        const serverName = sep > 0 ? toolId.slice(0, sep) : toolId;
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
        group.hits.push({
          toolId,
          score,
          description: tool.description ?? "",
          inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
        });
      };
      for (const h of toolHits) addTool(h.toolId, h.score);

      // Skills are ranked in their own bucket against the same query (reserved
      // budget → never starved by tools). SkillCatalog.search emits its own
      // skill_search trace for the funnel.
      const skills: CapabilitySkillHit[] = skillCatalog
        ? skillCatalog.search(query, kSkills, "agent").map((h) => ({
            skillId: h.skillId,
            score: h.score,
            description: compactDescription(skillCatalog.get(h.skillId)?.description ?? ""),
          }))
        : [];

      // A matched skill's instructions name the tools they call. Pull those into
      // the tools bucket so the agent gets the playbook and its toolkit in one
      // turn — additively (score 0), beyond topKTools, deduped against query hits.
      if (skillCatalog) {
        for (const s of skills) {
          for (const toolId of skillCatalog.get(s.skillId)?.tools ?? []) {
            addTool(toolId, 0);
          }
        }
      }

      const result: SearchCapabilitiesResult = {
        // biome-ignore lint/style/noNonNullAssertion: order entries are guaranteed by construction
        tools: { groups: order.map((n) => groups.get(n)!) },
        skills,
      };
      return result;
    },
  };
}

export interface InvokeToolToolOptions {
  /** Notified when the underlying tool throws UnauthorizedError, with the upstream name inferred from the toolId. */
  onUnauthorized?: (upstream: string) => void | Promise<void>;
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
      "first find one via the catalog's search tool, then run it here. " +
      "Pass the tool's arguments nested under the `args` field — do NOT flatten them to the top level.",
    inputSchema: {
      type: "object",
      properties: {
        toolId: {
          type: "string",
          description:
            "id of the tool to invoke (use the catalog's search tool to find available ids)",
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
          error: `unknown toolId: ${toolId}. Use the catalog's search tool to discover available ids.`,
          isError: true,
        };
      }
      const nested = inputObj.args;
      let args: Record<string, unknown>;
      if (nested === undefined || nested === null) {
        // No `args` given — tolerate a flattened call by treating the remaining
        // top-level keys as the arguments. Drop `args` too, so an explicit
        // `args: null` can't forward a stray `args` key to the tool.
        args = Object.fromEntries(
          Object.entries(inputObj).filter(([k]) => k !== "toolId" && k !== "args"),
        );
      } else if (typeof nested === "object" && !Array.isArray(nested)) {
        args = nested as Record<string, unknown>;
      } else {
        // `args` is present but not an object (string/array/number) — reject
        // rather than silently forwarding stray top-level keys as arguments.
        return {
          error: `invalid args for ${toolId}: \`args\` must be an object containing the tool's arguments.`,
          isError: true,
        };
      }
      const startedAt = Date.now();
      try {
        const result = await catalog.invoke(toolId, args);
        catalog.recordEvent({
          type: "gateway_invoke",
          tool_id: toolId,
          took_ms: Date.now() - startedAt,
        });
        return result;
      } catch (err) {
        if (isUnauthorizedError(err)) {
          const upstream = upstreamFromToolId(toolId);
          if (upstream && opts.onUnauthorized) {
            await opts.onUnauthorized(upstream);
          }
          recordAuthNeeded(upstream);
          catalog.recordEvent({
            type: "gateway_error",
            tool_id: toolId,
            error: "needs_auth",
          });
          const payload: { error: string; isError: true; upstream?: string; hint: string } = {
            error: "needs_auth",
            isError: true,
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
        return { error: `tool ${toolId} threw: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

function isUnauthorizedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "UnauthorizedError";
}
