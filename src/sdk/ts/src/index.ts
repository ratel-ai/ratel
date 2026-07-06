export type { SearchHit, Skill, SkillHit, Tool } from "../native/index.cjs";
export { SkillRegistry, ToolRegistry } from "../native/index.cjs";
export type {
  ExecutableTool,
  Executor,
  SearchMethod,
  SearchOrigin,
  ToolCatalogOptions,
  TraceSinkConfig,
} from "./catalog.js";
export { ToolCatalog } from "./catalog.js";
export type {
  CapabilitySkillHit,
  CapabilityToolGroup,
  CapabilityToolHit,
  InvokeToolToolOptions,
  SearchCapabilitiesOptions,
  SearchCapabilitiesResult,
  UpstreamServerInfo,
} from "./gateway.js";
export {
  formatUpstreamLine,
  INVOKE_TOOL_ID,
  invokeToolTool,
  SEARCH_CAPABILITIES_ID,
  searchCapabilitiesTool,
} from "./gateway.js";
// Deprecated pre-0.2.0 surface (see gateway-compat.ts) — kept so `@ratel-ai/sdk@0.1.x`
// callers keep compiling and running after upgrading to 0.2.0. Slated for removal (RAT-250).
export type {
  SearchToolHit,
  SearchToolsGroup,
  SearchToolsResult,
  SearchToolsToolOptions,
} from "./gateway-compat.js";
export { SEARCH_TOOLS_ID, searchToolsTool } from "./gateway-compat.js";
export type { McpServerHandle, RegisterMcpServerOptions } from "./mcp.js";
export { registerMcpServer } from "./mcp.js";
export type { SkillCatalogOptions } from "./skill-catalog.js";
export { SkillCatalog } from "./skill-catalog.js";
export { GET_SKILL_CONTENT_ID, getSkillContentTool } from "./skill-gateway.js";
