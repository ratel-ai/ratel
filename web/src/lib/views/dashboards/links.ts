import type { MetricGroupBy } from "@/lib/synthesis/metrics/catalog";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";

/** A dashboard's addresses, and the Traces page a widget reads from. */

export interface DashboardRange {
  preset: string;
  from: string;
  to: string;
}

const LIST_PARAMS = {
  models: "facetModel",
  tools: "facetTool",
  services: "facetService",
  environments: "facetEnvironment",
  agents: "facetAgent",
  mcpServers: "facetServer",
} as const satisfies Partial<Record<keyof TraceFilter, string>>;

const GROUP_FILTERS = {
  model: "models",
  tool: "tools",
  service: "services",
  environment: "environments",
  agent: "agents",
} as const satisfies Record<MetricGroupBy, keyof TraceFilter>;

export function dashboardsHref(projectId: string): string {
  return `/project/${encodeURIComponent(projectId)}/dashboards`;
}

export function dashboardHref(projectId: string, dashboardId: string): string {
  return `${dashboardsHref(projectId)}/${dashboardId}`;
}

/** The Traces page with a widget's filter and time range; with a group, that group's traces only. */
export function widgetTracesHref(
  projectId: string,
  filter: TraceFilter,
  range: DashboardRange,
  group?: { by: MetricGroupBy; value: string },
): string {
  const narrowed = group ? { ...filter, [GROUP_FILTERS[group.by]]: [group.value] } : filter;
  const params = new URLSearchParams(searchFromTraceFilter(narrowed));
  if (range.preset === "custom") {
    params.set("range", "custom");
    params.set("from", range.from);
    params.set("to", range.to);
  } else {
    params.set("range", range.preset);
  }
  return `/project/${encodeURIComponent(projectId)}/traces/turns?${params}`;
}

/** The filter bar's query string for a filter: the inverse of `traceFilterFromSearch`. */
export function searchFromTraceFilter(filter: TraceFilter): string {
  const params = new URLSearchParams();
  for (const [key, param] of Object.entries(LIST_PARAMS) as [keyof typeof LIST_PARAMS, string][])
    for (const value of filter[key] ?? []) params.append(param, value);
  if (filter.status) params.set("status", filter.status);
  if (filter.minCostUsd !== undefined) params.set("minCostUsd", String(filter.minCostUsd));
  if (filter.minTokens !== undefined) params.set("minTokens", String(filter.minTokens));
  const text = params.toString();
  return text ? `?${text}` : "";
}
