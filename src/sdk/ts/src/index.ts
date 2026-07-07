export type { SearchHit, Skill, SkillHit, Tool } from "../native/index.cjs";
export { SkillRegistry, ToolRegistry } from "../native/index.cjs";
export type {
  CapabilitySkillHit,
  CapabilityToolGroup,
  CapabilityToolHit,
  InvokeToolToolOptions,
  SearchCapabilitiesOptions,
  SearchCapabilitiesResult,
  UpstreamServerInfo,
} from "./capabilities.js";
export {
  formatUpstreamLine,
  INVOKE_TOOL_ID,
  invokeToolTool,
  SEARCH_CAPABILITIES_ID,
  searchCapabilitiesTool,
} from "./capabilities.js";
export type {
  ExecutableTool,
  Executor,
  SearchMethod,
  SearchOrigin,
  ToolCatalogOptions,
  TraceSinkConfig,
} from "./catalog.js";
export { ToolCatalog } from "./catalog.js";
// Deprecated pre-0.2.0 surface (see compat.ts) — kept so `@ratel-ai/sdk@0.1.x`
// callers keep compiling and running after upgrading to 0.2.0. Slated for removal (RAT-250).
export type {
  SearchToolHit,
  SearchToolsGroup,
  SearchToolsResult,
  SearchToolsToolOptions,
} from "./compat.js";
export { SEARCH_TOOLS_ID, searchToolsTool } from "./compat.js";
export type { McpServerHandle, RegisterMcpServerOptions } from "./mcp.js";
export { registerMcpServer } from "./mcp.js";
export type { SkillCatalogOptions } from "./skill-catalog.js";
export { SkillCatalog } from "./skill-catalog.js";
export { GET_SKILL_CONTENT_ID, getSkillContentTool } from "./skill-tools.js";
// OpenTelemetry export of the ratel.*/gen_ai.* funnel. The SDK always emits
// spans to the active OTel provider; `configureTelemetry` is optional sugar
// that wires a Ratel-owned OTLP exporter (needs the peer @ratel-ai/telemetry-otlp).
export type { InitOptions, TelemetryHandle } from "./telemetry.js";
export { configureTelemetry } from "./telemetry.js";
