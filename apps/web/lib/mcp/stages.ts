import type { LineageStage } from "@/lib/views/lineage/types";

/**
 * Which stage of the loop (Monitor → Insights → Improve → Ship) each MCP tool
 * belongs to. Published on every tool as `_meta["sh.ratel/stage"]` so a client
 * can group the tool list the way the console groups its navigation.
 *
 * This map is the only place stages are assigned. When the console's stage map
 * (RC-45) moves a surface from one stage to another, edit this map: tool names,
 * schemas and behaviour do not change, so no connected client breaks.
 *
 * `null` marks tools that sit outside the loop (identity, account, catalog
 * authoring). `stages.test.ts` fails when a tool is missing from the map.
 *
 * Owned (ADR-0030): the map names the tools this build has. The task tools
 * and the embedding usage tool are not here.
 */
export const TOOL_STAGES: Readonly<Record<string, LineageStage | null>> = {
  // Outside the loop: who you are, what you can reach, limits, background jobs.
  whoami: null,
  list_projects: null,
  get_flag_status: null,
  get_quota_status: null,
  get_job_status: null,

  // Monitor: what the agent did, and whether data is arriving.
  get_project_overview: "monitor",
  list_traces: "monitor",
  get_trace: "monitor",
  get_trace_health: "monitor",
  list_span_groups: "monitor",
  get_span_totals: "monitor",
  get_cost_by_day: "monitor",
  get_cost_by_tool: "monitor",
  get_traces_ingest_diagnostics: "monitor",
  list_declared_tools: "monitor",
  list_invoked_tools: "monitor",
  get_catalog_status: "monitor",

  // Insights: what the data says is wrong or worth changing.
  list_insights: "insights",
  get_improvement_signals: "insights",
  list_search_queries_for_skill: "insights",
  list_tool_cousage: "insights",
  list_tool_transitions: "insights",
  list_intent_tool_usage: "insights",

  // Improve: the proposed changes, and checking them before they ship.
  list_fixes: "improve",
  get_fix: "improve",
  run_eval: "improve",
  get_eval: "improve",
  create_experiment: "improve",
  list_match_quality_runs: "improve",
  get_match_quality_run: "improve",
  list_calibrations: "improve",
  get_calibration: "improve",
  list_calibration_mismatches: "improve",
  list_tool_crafts: "improve",
  get_tool_craft: "improve",
  generate_tool_crafts: "improve",
  test_retrieval: "improve",
  list_skills: "improve",
  get_skill: "improve",
  list_catalog_overrides: "improve",
  create_skill: "improve",
  update_skill: "improve",
  archive_skill: "improve",
  import_skills: "improve",

  // Ship: changes that go live, and the record that they did.
  set_catalog_override: "ship",
  publish_skill: "ship",
  mark_fix_shipped: "ship",
};

export const STAGE_META_KEY = "sh.ratel/stage";

/** The `_meta` a tool is published with; empty for tools outside the loop. */
export function stageMeta(toolId: string): Record<string, unknown> {
  const stage = TOOL_STAGES[toolId];
  return stage ? { [STAGE_META_KEY]: stage } : {};
}
