import type { ExecutableTool } from "./catalog.js";
import { compactDescription } from "./compact.js";
import type { SkillCatalog } from "./skill-catalog.js";

/**
 * Wire id (`"get_skill_content"`) of the skill-loading capability tool built
 * by {@link getSkillContentTool} — the name the model calls it by.
 */
export const GET_SKILL_CONTENT_ID = "get_skill_content" as const;

/**
 * Build the `get_skill_content` capability tool: load a skill's full
 * instructions by id — the counterpart to `invoke_tool`. Skills are *read*,
 * not executed: the agent discovers a skill in the `skills` bucket of
 * `search_capabilities`, then pulls its playbook into context here.
 *
 * The tool takes `{ skillId }` and resolves to `{ body }` (the skill's
 * Markdown) on success, or `{ error, isError: true }` for an unknown id — a
 * structured result rather than a rejection, so the model can recover. When
 * the skill declares dependencies on other skills, the result also carries
 * `skills` — `[{ skillId, description }]` for the declared ids the catalog
 * knows, so the agent can recall them without another search; it is omitted
 * when there are none. Each load records a `ratel.skill.load` span plus a
 * `skill_invoke` trace event (unknown ids record `gateway_error`).
 *
 * @param catalog - Catalog whose skills this serves.
 * @returns The tool, ready to expose to the model.
 */
export function getSkillContentTool(catalog: SkillCatalog): ExecutableTool {
  return {
    id: GET_SKILL_CONTENT_ID,
    name: GET_SKILL_CONTENT_ID,
    description:
      "Load a skill's full instructions by its id. Use this after search_capabilities surfaces a " +
      "relevant skill: pull the complete playbook into your context, then follow it. " +
      "Returns the skill body (Markdown); any bundled scripts or files are referenced by absolute " +
      "path inside it. When the skill depends on other skills, a `skills` listing names them so " +
      "you can load them the same way.",
    inputSchema: {
      type: "object",
      properties: {
        skillId: {
          type: "string",
          description: "id of the skill to load (use search_capabilities to find available ids)",
        },
      },
      required: ["skillId"],
    },
    // `body` on success, `{ error, isError }` when the id is unknown. Both are
    // valid output, so no field is required: an MCP client validates structured
    // content against this schema, and requiring `body` would make the error path
    // throw a protocol error instead of returning the declared error. `isError`
    // lets the host flag the call as failed (see the server's wrapResult).
    outputSchema: {
      type: "object",
      properties: {
        body: { type: "string" },
        skills: {
          type: "array",
          items: {
            type: "object",
            properties: {
              skillId: { type: "string" },
              description: { type: "string" },
            },
            required: ["skillId", "description"],
          },
        },
        error: { type: "string" },
        isError: { type: "boolean" },
      },
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
          error: `unknown skillId: ${skillId}. Use search_capabilities to discover available ids.`,
          isError: true,
        };
      }
      const body = catalog.invoke(skillId);
      // Surface the skill's declared skill deps (known ids only) so the agent
      // can recall them with another get_skill_content call, no search needed.
      const deps = (catalog.get(skillId)?.skills ?? []).flatMap((depId) => {
        const dep = catalog.get(depId);
        return dep
          ? [{ skillId: depId, description: compactDescription(dep.description ?? "") }]
          : [];
      });
      return deps.length > 0 ? { body, skills: deps } : { body };
    },
  };
}
