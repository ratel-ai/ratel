import type { ExecutableTool } from "./catalog.js";
import { compactDescription } from "./compact.js";
import type { SkillCatalog } from "./skill-catalog.js";

export const SEARCH_SKILLS_ID = "search_skills" as const;
export const INVOKE_SKILL_ID = "invoke_skill" as const;

const SEARCH_SKILLS_DESCRIPTION =
  "Discover skills — reusable, task-specific playbooks (workflows, conventions, " +
  "step-by-step guides) that aren't loaded into your context by default. Call this " +
  "BEFORE improvising a multi-step task from scratch: a purpose-built skill may " +
  "already exist for it. Pass a natural-language query describing the task; you'll " +
  "get back the most relevant skill ids with short descriptions. Then load the chosen " +
  "one in full via invoke_skill.";

export interface SearchSkillHit {
  skillId: string;
  score: number;
  description: string;
}

/** A skill suggested alongside a tool result, with a directive to load it. */
export interface RelatedSkill {
  skillId: string;
  description: string;
  hint: string;
}

export interface RelatedSkillsOptions {
  /** Max suggestions to return (default 2). */
  limit?: number;
}

/**
 * Rank the skill catalog against a free-text query (e.g. a tool's name +
 * description) and return the top matches as advisory suggestions. Used to
 * surface a relevant skill at the moment the agent is choosing or running a
 * tool, so it can `invoke_skill` the playbook before proceeding. Returns `[]`
 * when nothing matches or no catalog is wired.
 */
export function relatedSkillsFor(
  catalog: SkillCatalog,
  query: string,
  options: RelatedSkillsOptions = {},
): RelatedSkill[] {
  const limit = options.limit ?? 2;
  return catalog.search(query, limit, "agent").map((hit) => ({
    skillId: hit.skillId,
    description: compactDescription(catalog.get(hit.skillId)?.description ?? ""),
    hint: `A purpose-built skill may help here — load it with invoke_skill("${hit.skillId}") before proceeding.`,
  }));
}

export interface SearchSkillsResult {
  skills: SearchSkillHit[];
}

export function searchSkillsTool(catalog: SkillCatalog): ExecutableTool {
  return {
    id: SEARCH_SKILLS_ID,
    name: SEARCH_SKILLS_ID,
    description: SEARCH_SKILLS_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "describe the task you want to accomplish" },
        topK: { type: "number", description: "max number of skill ids to return (default 5)" },
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      properties: {
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
      required: ["skills"],
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
      const skills: SearchSkillHit[] = hits.map((h) => ({
        skillId: h.skillId,
        score: h.score,
        description: compactDescription(catalog.get(h.skillId)?.description ?? ""),
      }));
      const result: SearchSkillsResult = { skills };
      return result;
    },
  };
}

export function invokeSkillTool(catalog: SkillCatalog): ExecutableTool {
  return {
    id: INVOKE_SKILL_ID,
    name: INVOKE_SKILL_ID,
    description:
      "Load a skill's full instructions by its id. Use this after search_skills to pull " +
      "the complete playbook for a task into your context, then follow it. " +
      "Returns the skill body (Markdown); any bundled scripts or files are referenced by " +
      "absolute path inside it.",
    inputSchema: {
      type: "object",
      properties: {
        skillId: {
          type: "string",
          description: "id of the skill to load (use search_skills to find available ids)",
        },
      },
      required: ["skillId"],
    },
    outputSchema: {
      type: "object",
      properties: { body: { type: "string" } },
      required: ["body"],
    },
    execute: async (input) => {
      const { skillId } = input as { skillId: string };
      if (!catalog.has(skillId)) {
        catalog.recordEvent({
          type: "gateway_error",
          tool_id: skillId,
          error: "unknown_skill_id",
        });
        return {
          error: `unknown skillId: ${skillId}. Use search_skills to discover available ids.`,
        };
      }
      const body = catalog.invoke(skillId);
      return { body };
    },
  };
}
