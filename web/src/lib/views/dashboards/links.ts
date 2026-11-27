import type { Dimension, FunnelQuery, MetricDimension, StepFlowQuery } from "@/lib/contracts/query";
import { NO_GROUP, type StepFlowNodeCount } from "@/lib/synthesis/metrics/step-flow-columns";
import { simplified, withClause } from "@/lib/synthesis/traces/trace-filter-clauses";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import { packFilter, searchFromTraceFilter } from "@/lib/synthesis/traces/v2/filters";
import { EXACT_RANGE } from "@/lib/synthesis/traces/view";

/** A dashboard's addresses, and the Traces page a widget reads from. */

export interface DashboardRange {
  preset: string;
  from: string;
  to: string;
}

export { EXACT_RANGE, searchFromTraceFilter };

/** The instants of a range: a day runs to the end of the day, an instant is itself. */
export function rangeWindow({ from, to }: Pick<DashboardRange, "from" | "to">): {
  since: Date;
  until: Date;
} {
  const day = (text: string) => text.length === 10;
  const since = new Date(day(from) ? `${from}T00:00:00Z` : from);
  const end = new Date(day(to) ? `${to}T00:00:00Z` : to);
  return { since, until: day(to) ? new Date(end.getTime() + 86_400_000) : end };
}

/** A longer query string is packed: no person reads it. */
export const MAX_PLAIN_CHARS = 2_800;

export const ADD_SCORER_PARAM = "addScorer";

/** The dimensions the Traces filter can say. It has no scorer; a property is a clause of its own. */
const GROUP_FILTERS: Partial<Record<Dimension, ListFilterKey>> = {
  model: "models",
  tool: "tools",
  service: "services",
  environment: "environments",
  agent: "agents",
  user: "users",
  session: "sessions",
};

type ListFilterKey =
  | "models"
  | "tools"
  | "services"
  | "environments"
  | "agents"
  | "users"
  | "sessions";

export function dashboardsHref(projectId: string): string {
  return `/project/${encodeURIComponent(projectId)}/dashboards`;
}

export function dashboardHref(projectId: string, dashboardId: string): string {
  return `${dashboardsHref(projectId)}/${dashboardId}`;
}

/** The dashboard with the editor open on a widget of that scorer. */
export function addScorerHref(projectId: string, dashboardId: string, scorerId: string): string {
  return `${dashboardHref(projectId, dashboardId)}?${ADD_SCORER_PARAM}=${encodeURIComponent(scorerId)}`;
}

/** The Intents map, which a clusters widget shows a part of. */
export function intentsMapHref(projectId: string): string {
  return `/project/${encodeURIComponent(projectId)}/intents/map`;
}

/** The Traces page with a widget's filter and time range; with groups, those groups' traces only. */
export function widgetTracesHref(
  projectId: string,
  filter: TraceFilter,
  range: DashboardRange,
  groups: readonly { by: MetricDimension; value: string }[] = [],
): string {
  // A group is a clause: its value says nothing of the filter's own values.
  const all = groups.reduce<TraceFilter>((kept, { by, value }) => {
    if (typeof by !== "string") return withClause(kept, { properties: { [by.property]: [value] } });
    const key = GROUP_FILTERS[by];
    return key ? withClause(kept, { [key]: [value] }) : kept;
  }, filter);
  const params = new URLSearchParams(filterSearch(simplified(all)));
  if (range.preset === "custom" || range.preset === EXACT_RANGE) {
    params.set("range", range.preset);
    params.set("from", range.from);
    params.set("to", range.to);
  } else {
    params.set("range", range.preset);
  }
  return `/project/${encodeURIComponent(projectId)}/traces/turns?${params}`;
}

/** The filter's query string; a long one as one packed clause, which `MAX_FILTER_BYTES` keeps short enough. */
function filterSearch(filter: TraceFilter): string {
  const search = searchFromTraceFilter(filter);
  return search.length <= MAX_PLAIN_CHARS ? search : `?and=${packFilter(filter)}`;
}

/** The days of a range, for a label. */
export function wholeDays({ preset, from, to }: DashboardRange): { from: string; to: string } {
  if (preset !== EXACT_RANGE) return { from, to };
  // A window ends before its end: at midnight, its last day is the one before.
  const last = new Date(Math.max(Date.parse(from), Date.parse(to) - 1));
  return { from: from.slice(0, 10), to: last.toISOString().slice(0, 10) };
}

/**
 * The filter that keeps exactly the traces that reached a step, or null when the Traces filter
 * cannot say it: it knows one tool and the error status, no order, no skill, no check, no scorer.
 */
export function funnelStepFilter(
  { steps, filters }: FunnelQuery,
  index: number,
): TraceFilter | null {
  const filter: TraceFilter = { ...filters };
  for (const { condition } of steps.slice(0, index + 1)) {
    if (condition.type === "tool" && !filter.tools?.length) filter.tools = [condition.name];
    else if (condition.type === "no_error" && filter.status !== "failed") filter.status = "ok";
    else return null;
  }
  return filter;
}

/**
 * The filter that keeps the traces of a step flow's node, or null when the Traces filter cannot say
 * it: it knows no skill, no intent and no step, so a node's traces are those that had it at any step.
 */
export function stepFlowFilter(
  query: Pick<StepFlowQuery, "node" | "start" | "mode" | "target" | "filters">,
  { kind, name }: Pick<StepFlowNodeCount, "kind" | "name">,
): TraceFilter | null {
  const { node: by, start, filters, target } = query;
  if (kind === "node")
    return by === "skill" ? null : narrowed(filters, { [STEP_FILTERS[by]]: [name] });
  if (kind !== "start") return null;
  const agent = start === "agent" && name !== NO_GROUP.agent ? { agents: [name] } : null;
  if (start !== "none" && !agent) return null;
  if (query.mode === "every_call" || !target) return narrowed(filters, agent ?? {});
  if (by === "skill" || (by === "agent" && agent)) return null;
  return narrowed(filters, { ...agent, [STEP_FILTERS[by]]: [target] });
}

function narrowed(filter: TraceFilter, clause: TraceFilter): TraceFilter {
  return simplified(withClause(filter, clause));
}

const STEP_FILTERS = {
  tool: "tools",
  agent: "agents",
  mcp_server: "mcpServers",
  model: "models",
} as const satisfies Record<Exclude<StepFlowQuery["node"], "skill">, keyof TraceFilter>;
