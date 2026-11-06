/**
 * The Ratel gateway's meta-tools — the fixed handful the model sees *instead of*
 * the real catalog when an agent runs through the gateway (direct-SDK or MCP).
 * The model discovers tools with `search_capabilities`, runs one via `invoke_tool`
 * (the real tool id rides in the call arguments, not the call name), and loads a
 * skill's instructions with `get_skill_content`.
 *
 * For the dashboard these three are the gateway's own *definition overhead* —
 * shipped in every prompt — not the agent's real tools. So the Tools tab unwraps
 * `invoke_tool` calls to the inner tool they ran (see `lib/categorize.ts`) and
 * hides the meta-tools by default (see `components/dashboard/ToolsChart.tsx`).
 */

export const SEARCH_CAPABILITIES_ID = "search_capabilities";
export const INVOKE_TOOL_ID = "invoke_tool";
export const GET_SKILL_CONTENT_ID = "get_skill_content";
/** Pre-0.2.0 name for `search_capabilities`; older SDKs still emit it. */
export const SEARCH_TOOLS_ID = "search_tools";

/** Every gateway meta-tool name, so the Tools tab can filter them as a group. */
export const GATEWAY_TOOL_IDS: ReadonlySet<string> = new Set([
  SEARCH_CAPABILITIES_ID,
  INVOKE_TOOL_ID,
  GET_SKILL_CONTENT_ID,
  SEARCH_TOOLS_ID,
]);

/** True for a Ratel gateway meta-tool (not one of the agent's real tools). */
export function isGatewayTool(name: string): boolean {
  return GATEWAY_TOOL_IDS.has(name);
}

/**
 * The inner tool id an `invoke_tool` call actually ran, from its parsed arguments.
 * The gateway schema nests it as `toolId` (`{ toolId, args }`); we also accept a
 * snake-cased `tool_id` in case a harness rewrites arg keys. Returns null when
 * absent or blank, so a malformed call falls back to the wrapper name.
 */
export function innerToolId(args: Record<string, unknown> | undefined): string | null {
  const id = args?.toolId ?? args?.tool_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
