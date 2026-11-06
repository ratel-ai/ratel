import type { ScorerKind } from "@/lib/views/task-scorers/types";

export const SCORER_LABELS: Record<ScorerKind | "overall", string> = {
  overall: "Overall",
  judge_criteria: "Task criteria",
  ends_well: "Finishes cleanly",
  max_self_corrections: "Self-corrections",
  max_latency_ms: "Run time",
  max_cost_usd: "Cost per run",
  expected_tool: "Expected tool",
  max_tool_calls: "Tool calls",
};

export const FINISHES_CLEANLY_HELP = "The last tool call succeeded and the agent replied.";
