import type { ExecutableTool } from "./catalog.js";
import type { SkillCatalog } from "./skill-catalog.js";

export const GET_SKILL_CONTENT_ID = "get_skill_content" as const;

/**
 * Load a skill's full instructions by id — the counterpart to `invoke_tool`.
 * Skills are *read*, not executed: the agent discovers a skill in the `skills`
 * bucket of `search_capabilities`, then pulls its playbook into context here.
 */
export function getSkillContentTool(catalog: SkillCatalog): ExecutableTool {
  return {
    id: GET_SKILL_CONTENT_ID,
    name: GET_SKILL_CONTENT_ID,
    description:
      "Load a skill's full instructions by its id. Use this after search_capabilities surfaces a " +
      "relevant skill: pull the complete playbook into your context, then follow it. " +
      "Returns the skill body (Markdown); any bundled scripts or files are referenced by absolute " +
      "path inside it.",
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
      return { body };
    },
  };
}
