import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import {
  ATTRIBUTE_PREFIX,
  type CheckOperator,
  type ScorerDefinition,
  type ScorerKind,
  type SkipReason,
  type TraceField,
  type TraceScore,
} from "./types";

export const KIND_LABELS: Record<ScorerKind, string> = { check: "Check", judge: "Judged" };

export const FIELD_LABELS: Record<TraceField, string> = {
  duration_ms: "Duration (ms)",
  cost_usd: "Cost (USD)",
  input_tokens: "Input tokens",
  output_tokens: "Output tokens",
  total_tokens: "Total tokens",
  error: "Failed",
  models: "Models",
  tools: "Tools",
  agents: "Agents",
  mcp_servers: "MCP servers",
  service: "Service",
  environment: "Environment",
};

export const OPERATOR_LABELS: Record<CheckOperator, string> = {
  eq: "is",
  ne: "is not",
  contains: "contains",
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  exists: "exists",
};

export const SKIP_LABELS: Record<SkipReason, string> = {
  missing_attribute: "The trace does not have this value",
  not_a_number: "The value is not a number",
  no_engine: "No model is configured",
  no_content: "The trace has no captured messages",
  budget_spent: "Today's model budget is spent",
  no_answer: "The model gave no answer",
};

/** What a scorer checks, in one line. */
export function definitionSummary(definition: ScorerDefinition): string {
  if (definition.kind === "judge") return definition.config.prompt;
  const { path, op, value } = definition.config;
  const subject = path.startsWith(ATTRIBUTE_PREFIX)
    ? path.slice(ATTRIBUTE_PREFIX.length)
    : FIELD_LABELS[path as TraceField];
  return [subject, OPERATOR_LABELS[op], value === undefined ? "" : String(value)]
    .filter(Boolean)
    .join(" ");
}

/** A result in words: "Pass", "Fail", or "4 of 5". */
export function scoreLabel({ passed, value }: Pick<TraceScore, "passed" | "value">): string {
  if (passed === null) return `${formatAverage(value)} of 5`;
  return passed ? "Pass" : "Fail";
}

/** A 1 to 5 average, with one decimal unless it is whole. */
export function formatAverage(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

/** True when a scorer's results are pass or fail; false for a 1 to 5 number. */
export function hasVerdict(definition: ScorerDefinition): boolean {
  return definition.kind === "check" || definition.config.output === "boolean";
}

/** The query string `TraceFilterBar` edits, for a stored filter (`traceFilterFromSearch` reads it back). */
export function searchOfFilter(filter: TraceFilter): string {
  const params = new URLSearchParams();
  const lists = {
    facetModel: filter.models,
    facetTool: filter.tools,
    facetService: filter.services,
    facetEnvironment: filter.environments,
    facetAgent: filter.agents,
    facetServer: filter.mcpServers,
  };
  for (const [name, values] of Object.entries(lists))
    for (const value of values ?? []) params.append(name, value);
  if (filter.status) params.set("status", filter.status);
  if (filter.minCostUsd) params.set("minCostUsd", String(filter.minCostUsd));
  if (filter.minTokens) params.set("minTokens", String(filter.minTokens));
  const text = params.toString();
  return text ? `?${text}` : "";
}
