import type { Registration } from "@/lib/contracts/registry";
import { editionToolStage } from "@/lib/mcp/operations/edition";
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
 * Owned (ADR-0030): the map names the core's tools. A tool an edition adds
 * (upstream's embedding and Tool Picker usage) carries its own stage, which
 * `toolStage` reads.
 */
export const TOOL_STAGES: Readonly<Record<string, LineageStage | null>> = {
  // Outside the loop: who you are, what you can reach, limits, background jobs.
  whoami: null,
  list_projects: null,
  get_flag_status: null,
  get_quota_status: null,
  get_job_status: null,
  get_analysis_freshness: null,
  list_api_keys: null,
  get_sdk_setup: null,

  // Monitor: what the agent did, and whether data is arriving.
  list_tasks: "monitor",
  get_task: "monitor",
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
  get_run_summary: "monitor",
  get_run_stats: "monitor",
  get_span: "monitor",
  get_trace_conversation: "monitor",
  get_trace_ranking: "monitor",
  list_spans: "monitor",
  list_logs: "monitor",
  compare_traces: "monitor",
  get_turn: "monitor",
  get_session: "monitor",
  get_session_step_content: null,
  list_sdk_events: "monitor",
  get_sdk_event: "monitor",

  // Insights: what the data says is wrong or worth changing.
  list_insights: "insights",
  get_improvement_signals: "insights",
  list_search_queries_for_skill: "insights",
  list_tool_cousage: "insights",
  list_tool_transitions: "insights",
  list_intent_tool_usage: "insights",
  get_agent_health: "insights",
  list_issue_examples: "insights",
  get_self_corrections: "insights",
  list_intents: "insights",
  get_intent: "insights",
  get_quality: "insights",
  set_health_signal_hidden: "insights",
  request_analysis: "insights",

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
  list_runtime_catalog: "improve",
  list_description_rewrites: "improve",
  run_quality_analysis: "improve",
  list_ranking_graphs: "improve",
  get_ranking_graph: "improve",
  get_experiment: "improve",
  get_selection: "improve",
  list_task_simulations: "improve",
  get_fix_eval_set: "improve",
  change_task_scorer: "improve",
  change_task_eval_set: "improve",
  draft_task_test: "improve",
  change_task_simulation: "improve",
  change_fix_eval_set: "improve",
  dismiss_fix: "improve",

  // Ship: changes that go live, and the record that they did.
  set_catalog_override: "ship",
  publish_skill: "ship",
  mark_fix_shipped: "ship",
  review_description_rewrite: "ship",
  list_shipments: "ship",
  get_lineage: "ship",
};

export const STAGE_META_KEY = "sh.ratel/stage";

/**
 * A tool's stage: the map above for a core tool, the tool's own `stage` for one an edition adds
 * (`operations/edition.ts`), null outside the loop or for an unknown tool.
 */
export function toolStage(
  toolId: string,
  registrations?: readonly Registration[],
): LineageStage | null {
  return TOOL_STAGES[toolId] ?? editionToolStage(toolId, registrations) ?? null;
}

/** The `_meta` a tool is published with; empty for tools outside the loop. */
export function stageMeta(
  toolId: string,
  registrations?: readonly Registration[],
): Record<string, unknown> {
  const stage = toolStage(toolId, registrations);
  return stage ? { [STAGE_META_KEY]: stage } : {};
}
