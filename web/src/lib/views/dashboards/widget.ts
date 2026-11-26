import {
  type Aggregation,
  type ClustersQuery,
  clustersQuery,
  type Dimension,
  type FunnelStep,
  flowQuery,
  funnelQuery,
  type GeographyQuery,
  geographyQuery,
  type MeasureId,
  type MetricQuery,
  metricQuery,
  type Query,
  type StepFlowNode,
  type StepFlowQuery,
  stepFlowQuery,
} from "@/lib/contracts/query";
import { placeName } from "@/lib/ingest/geo/codes";
import { getMetric, type MetricDefinition } from "@/lib/synthesis/metrics/catalog";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import {
  METRIC_CHARTS,
  type MetricWidget,
  type WidgetChart,
  type WidgetInput,
  type WidgetKind,
  type WidgetQuery,
} from "@/lib/views/dashboards/types";
import type { PickerScorer } from "@/lib/views/scorers/picker";

/** What fits a widget, and how it is named. Safe for the browser. */

export const CHART_LABELS: Readonly<Record<WidgetChart, string>> = {
  line: "Line",
  bar: "Bar",
  number: "Number",
  table: "Table",
  flow: "Flow",
  step_flow: "Step flow",
  funnel: "Funnel",
  clusters: "Clusters",
  geography: "Map",
};

export const KIND_LABELS: Readonly<Record<WidgetKind, string>> = {
  metric: "Metric",
  flow: "Flow",
  step_flow: "Step flow",
  funnel: "Funnel",
  clusters: "Clusters",
  geography: "Map",
};

const NODE_LABELS: Readonly<Record<StepFlowNode, string>> = {
  tool: "Tools",
  skill: "Skills",
  agent: "Agents",
  mcp_server: "MCP servers",
  model: "Models",
};

const AGGREGATION_LABELS: Readonly<Record<Aggregation, string>> = {
  count: "Count",
  rate: "Rate",
  sum: "Total",
  avg: "Average per trace",
  p50: "p50",
  p95: "p95",
};

const DIMENSION_LABELS: Readonly<Record<Dimension, string>> = {
  model: "Model",
  service: "Service",
  environment: "Environment",
  agent: "Agent",
  tool: "Tool",
  scorer: "Scorer",
};

/** Why a chart does not fit the grouping, or null. */
export function chartProblem({ chart, query }: Pick<WidgetInput, "chart" | "query">) {
  if (query.kind !== "metric")
    return chart === query.kind ? null : `A ${query.kind} is drawn as a ${query.kind}.`;
  if (!isMetricChart(chart)) return `A metric cannot be drawn as a ${chart}.`;
  const grouped = query.dimensions.length > 0;
  if (chart === "table" && !grouped) return "A table needs a group-by.";
  if (chart === "number" && grouped) return "A number cannot be grouped.";
  return null;
}

/** What one field of the query editor changes. */
export interface QueryChange {
  measure?: MeasureId;
  aggregation?: Aggregation;
  dimensions?: Dimension[];
  filter?: TraceFilter;
  /** Null: every scorer. */
  scorerId?: string | null;
}

/** The nearest query the contract allows after one field changes. */
export function changeQuery(
  query: MetricQuery,
  change: QueryChange,
  scorers: readonly Pick<PickerScorer, "id" | "name" | "verdict">[],
): MetricQuery {
  const [current] = query.measures;
  const metric = getMetric(change.measure ?? current.measure);
  if (!metric) return query;
  const aggregation = change.aggregation ?? current.aggregation;
  const { scorer: currentScorer, ...currentFilter } = query.filters;
  const filter = change.filter ?? currentFilter;
  const scorerId = change.scorerId === undefined ? currentScorer?.id : change.scorerId;
  // A pass rate has no 1 to 5 scorer, and the average no pass or fail one.
  const reads =
    metric.source === "scores" &&
    scorersOfMetric(metric.id, scorers).some(({ id }) => id === scorerId);
  const { bucket } = query;
  return metricQuery(
    metric.id,
    metric.aggregations.includes(aggregation) ? aggregation : metric.aggregations[0],
    {
      dimensions: (change.dimensions ?? query.dimensions).filter((dimension) =>
        metric.dimensions.includes(dimension),
      ),
      filters: {
        ...(metric.filterable ? (filter as MetricQuery["filters"]) : {}),
        ...(scorerId && reads ? { scorer: { id: scorerId } } : {}),
      },
      ...(bucket && metric.buckets.includes(bucket) ? { bucket } : {}),
    },
  );
}

/** The nearest map after one field of the measure changes. */
export function changeGeography(
  query: GeographyQuery,
  change: QueryChange,
  scorers: readonly Pick<PickerScorer, "id" | "name" | "verdict">[],
): GeographyQuery {
  const { measures, filters } = changeQuery(
    metricQuery(query.measures[0].measure, query.measures[0].aggregation, {
      filters: query.filters,
    }),
    change,
    scorers,
  );
  return { ...query, measures, filters };
}

/** The nearest widget whose chart fits its query: what the editor shows after a change. */
export function fitWidget(widget: MetricWidget): MetricWidget;
export function fitWidget(widget: WidgetInput): WidgetInput;
export function fitWidget(widget: WidgetInput): WidgetInput {
  const { query, chart } = widget;
  if (query.kind !== "metric") return { ...widget, chart: query.kind };
  if (!isMetricChart(chart)) return fitWidget({ ...widget, chart: "line" });
  if (chart === "number") return { ...widget, query: { ...query, dimensions: [] } };
  if (chart !== "table" || query.dimensions.length > 0) return widget;
  const [first] = getMetric(query.measures[0].measure)?.dimensions ?? [];
  return first
    ? { ...widget, query: { ...query, dimensions: [first] } }
    : { ...widget, chart: "line" };
}

/** The widget a person starts from when they pick a kind: its filter stays where the kind has one. */
export function widgetOfKind(kind: WidgetKind, from: WidgetInput): WidgetInput {
  if (from.query.kind === kind) return from;
  const filters = queryFilter(from.query) ?? {};
  switch (kind) {
    case "metric":
      return {
        ...from,
        query: metricQuery("trace_count", "count", { filters: filters as MetricQuery["filters"] }),
        chart: "line",
      };
    case "flow":
      return {
        ...from,
        query: flowQuery("tool", { filters: filters as MetricQuery["filters"] }),
        chart: "flow",
      };
    case "step_flow":
      return {
        ...from,
        query: stepFlowQuery("tool", { filters: filters as MetricQuery["filters"] }),
        chart: "step_flow",
      };
    case "funnel":
      return {
        ...from,
        query: funnelQuery([...NEW_FUNNEL], { filters: filters as MetricQuery["filters"] }),
        chart: "funnel",
      };
    case "clusters":
      return { ...from, query: clustersQuery("asks"), chart: "clusters" };
    case "geography":
      return {
        ...from,
        query: geographyQuery("trace_count", "count", {
          filters: filters as MetricQuery["filters"],
        }),
        chart: "geography",
      };
  }
}

/** What a new funnel starts from: the fewest steps it may have. */
const NEW_FUNNEL: readonly FunnelStep[] = [
  { name: "Called a tool", condition: { type: "attribute", path: "tools", op: "exists" } },
  { name: "No error", condition: { type: "no_error" } },
];

/** The catalog entry a query reads, or null for a kind without one. */
export function queryMetric(query: Query): MetricDefinition | null {
  return measuresOne(query) ? getMetric(query.measures[0].measure) : null;
}

/** A query's own trace filter, without its scorer. */
export function queryFilter(query: WidgetQuery): TraceFilter {
  if (query.kind === "clusters") return {};
  if (!measuresOne(query)) return query.filters;
  const { scorer: _, ...filter } = query.filters;
  return filter;
}

export function queryScorerId(query: Query): string | undefined {
  return measuresOne(query) ? query.filters.scorer?.id : undefined;
}

/** The kinds that show one measure of the catalog. */
export function measuresOne(query: Query): query is MetricQuery | GeographyQuery {
  return query.kind === "metric" || query.kind === "geography";
}

/** The query with another trace filter; its scorer stays. */
export function withFilter<Q extends WidgetQuery>(query: Q, filter: TraceFilter): Q {
  if (query.kind === "clusters") return query;
  const scorer = queryScorerId(query);
  return { ...query, filters: { ...filter, ...(scorer ? { scorer: { id: scorer } } : {}) } };
}

/** Whether the dashboard's filters narrow it. */
export function isFilterable(query: WidgetQuery): boolean {
  if (query.kind === "clusters") return false;
  return !measuresOne(query) || queryMetric(query)?.filterable === true;
}

export function isMetricChart(chart: WidgetChart): chart is (typeof METRIC_CHARTS)[number] {
  return (METRIC_CHARTS as readonly WidgetChart[]).includes(chart);
}

export function flowNodeLabel(node: StepFlowNode): string {
  return NODE_LABELS[node];
}

/** "tool", "MCP server": one of a flow's nodes in a sentence. */
export function flowNodeNoun(node: StepFlowNode): string {
  const label = flowNodeLabel(node).slice(0, -1);
  return node === "mcp_server" ? label : label.toLowerCase();
}

export function aggregationLabel(aggregation: Aggregation): string {
  return AGGREGATION_LABELS[aggregation];
}

export function dimensionLabel(dimension: Dimension): string {
  return DIMENSION_LABELS[dimension];
}

/** The scorers a metric can read: pass or fail for the pass rate, 1 to 5 for the average. */
export function scorersOfMetric<T extends Pick<PickerScorer, "verdict">>(
  metric: MeasureId,
  scorers: readonly T[],
): readonly T[] {
  if (metric === "scorer_count") return scorers;
  return scorers.filter(({ verdict }) => verdict === (metric === "scorer_pass_rate"));
}

/** The widget "Add to dashboard" starts from on a scorer's page. */
export function scorerWidget({ id, verdict }: Pick<PickerScorer, "id" | "verdict">): MetricWidget {
  return {
    title: "",
    query: metricQuery(verdict ? "scorer_pass_rate" : "scorer_average", verdict ? "rate" : "avg", {
      filters: { scorer: { id } },
    }),
    chart: "line",
  };
}

/** A value as text, the same whatever the order of its keys. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_, part) =>
    part && typeof part === "object" && !Array.isArray(part)
      ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => (a < b ? -1 : 1)))
      : part,
  );
}

/** "Latency p95 by model": the name of a widget without its own title. */
export function widgetName({ title, query }: Pick<WidgetInput, "title" | "query">): string {
  return title || queryName(query);
}

export function queryName(query: NamedQuery): string {
  switch (query.kind) {
    case "metric":
      return metricName(query);
    case "flow":
      return [
        `${flowNodeLabel(query.node).slice(0, -1)} flow`,
        query.start && `from ${query.start}`,
        query.end && `to ${query.end}`,
      ]
        .filter(Boolean)
        .join(" ");
    case "step_flow":
      return query.mode === "before"
        ? `What comes before ${query.target}`
        : `${flowNodeLabel(query.node).slice(0, -1)} step flow${query.start === "none" ? "" : ` by ${query.start}`}`;
    case "funnel": {
      const { steps } = query;
      return `Funnel: ${steps[0].name} to ${steps[steps.length - 1].name}`;
    }
    case "clusters":
      // Never a cluster's name: it comes from people's asks, and a title becomes an attribute.
      return query.view === "asks" ? "Intent clusters" : "Tools of the intent clusters";
    case "geography":
      return query.country
        ? `${metricName({ ...query, dimensions: [] })} by region of ${placeName(query.country)}`
        : `${metricName({ ...query, dimensions: [] })} by country`;
    case "sql":
      return "RQL query";
  }
}

/** What the name of a query is made of: a portable one has it too. */
type NamedQuery =
  | Pick<MetricQuery, "kind" | "measures" | "dimensions">
  | Extract<Query, { kind: "flow" }>
  | Pick<StepFlowQuery, "kind" | "node" | "start" | "mode" | "target">
  | { kind: "funnel"; steps: readonly { name: string }[] }
  | Pick<ClustersQuery, "kind" | "view">
  | Pick<GeographyQuery, "kind" | "measures" | "country">
  | { kind: "sql" };

function metricName({
  measures: [{ measure, aggregation }],
  dimensions,
}: Pick<MetricQuery, "measures" | "dimensions">): string {
  const metric = getMetric(measure);
  const label = metric?.label ?? measure;
  const how =
    metric && metric.aggregations.length > 1 && aggregation !== "sum"
      ? ` ${aggregation === "avg" ? "per trace" : aggregation}`
      : "";
  return `${label}${how}${dimensions.length > 0 ? ` by ${dimensions.join(" and ")}` : ""}`;
}
