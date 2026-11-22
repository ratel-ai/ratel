import type { JobKind } from "@/lib/jobs/runner";

/**
 * The background jobs behind each analysis page (RC-210), so a page can say
 * "updating" while its own work is queued or running, and refresh itself when
 * it lands. The chain is build_trace_turns → compute_trace_signals →
 * (score_tasks, label_workflows, assign_topics, explore_tool_usage → craft_tools,
 * draft_fix). Turn builds run on every ingest batch, so they are left out:
 * an active project would read as "always updating". Work a person starts and watches in place (a fix or task
 * simulation, a What-if step, an eval set refresh) is left out too: those
 * show their own state. Imports show in the sidebar line. Quality has its
 * own "Analysing…" run menu, and Adaptive ranking folds every few minutes, so
 * neither gets a page status.
 */
export const ANALYSIS_SECTIONS = {
  overview: [
    "compute_trace_signals",
    "label_workflows",
    "assign_topics",
    "craft_tools",
    "match_quality_run",
  ],
  health: ["compute_trace_signals", "label_workflows"],
  self_corrections: ["compute_trace_signals", "assign_topics"],
  tasks: ["compute_trace_signals", "label_workflows", "assign_topics", "score_tasks"],
  intents: ["compute_trace_signals", "assign_topics", "cluster_intents"],
  fixes: [
    "compute_trace_signals",
    "explore_tool_usage",
    "craft_tools",
    "match_quality_run",
    "draft_fix",
  ],
} as const satisfies Record<string, readonly JobKind[]>;

export type AnalysisSection = keyof typeof ANALYSIS_SECTIONS;

export function isAnalysisSection(value: unknown): value is AnalysisSection {
  return typeof value === "string" && Object.hasOwn(ANALYSIS_SECTIONS, value);
}

export function sectionJobKinds(section: AnalysisSection): readonly JobKind[] {
  return ANALYSIS_SECTIONS[section];
}
