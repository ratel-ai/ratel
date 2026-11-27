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
  type MetricDimension,
  type MetricForm,
  type MetricQuery,
  metricQuery,
  propertyOf,
  QUERY_VERSION,
  type Query,
  type SqlQuery,
  type StepFlowNode,
  type StepFlowQuery,
  stepFlowQuery,
} from "@/lib/contracts/query";
import { placeName } from "@/lib/ingest/geo/codes";
import { getMetric, type MetricDefinition } from "@/lib/synthesis/metrics/catalog";
import { RQL_VERSION } from "@/lib/synthesis/rql/domain/version";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import { formQuery } from "@/lib/views/dashboards/metric-rql";
import {
  METRIC_CHARTS,
  type MetricChartKind,
  type MetricWidget,
  type WidgetChart,
  type WidgetInput,
  type WidgetKind,
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

/** The kind choice: a metric widget is kind sql, RQL that the form can write. */
export const KIND_LABELS: Readonly<Record<WidgetKind, string>> = {
  sql: "Metric",
  flow: "Flow",
  step_flow: "Step flow",
  funnel: "Funnel",
  clusters: "Clusters",
  geography: "Map",
};

/** What a new metric widget starts from: the newest traces, as a table. */
export const NEW_SQL_TEXT =
  "select trace_id, started_at, duration_ms, has_error, cost_usd, models\nfrom traces\norder by started_at desc\nlimit 50";

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
  user: "User",
  session: "Session",
  task: "Task",
  scorer: "Scorer",
};

/**
 * Why a chart does not fit the query, or null. A metric widget takes a line, a bar, a number or a
 * table: its rows decide which ones draw (`chartChoices`), so a text that gives other rows says why
 * at its chart control, not here.
 */
export function chartProblem({ chart, query }: Pick<WidgetInput, "chart" | "query">) {
  if (query.kind !== "sql")
    return chart === query.kind ? null : `A ${query.kind} is drawn as a ${query.kind}.`;
  if (!isMetricChart(chart)) return `A metric cannot be drawn as a ${chart}.`;
  if (chart === "number" && (query.form?.dimensions.length ?? 0) > 0)
    return "A number cannot be grouped.";
  return null;
}

/** What one field of the query editor changes. */
export interface QueryChange {
  measure?: MeasureId;
  aggregation?: Aggregation;
  dimensions?: MetricDimension[];
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
      // A trace property groups a measure a trace filter applies to.
      dimensions: (change.dimensions ?? query.dimensions).filter((dimension) =>
        propertyOf(dimension) === undefined
          ? metric.dimensions.includes(dimension as Dimension)
          : metric.filterable,
      ),
      filters: {
        ...(metric.filterable ? (filter as MetricQuery["filters"]) : {}),
        ...(scorerId && reads ? { scorer: { id: scorerId } } : {}),
      },
      ...(bucket && metric.buckets.includes(bucket) ? { bucket } : {}),
    },
  );
}

/** The nearest selection of the metric form after one field changes. */
export function changeForm(
  form: MetricForm,
  change: QueryChange,
  scorers: readonly Pick<PickerScorer, "id" | "name" | "verdict">[],
): MetricForm {
  const {
    version: _,
    kind: __,
    ...next
  } = changeQuery({ version: QUERY_VERSION, kind: "metric", ...form }, change, scorers);
  return next;
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

/**
 * The nearest widget whose chart fits its query: what the editor shows after a change. A metric
 * widget of the form gets the text of its selection again, so the text always follows the form.
 */
export function fitWidget(widget: MetricWidget): MetricWidget;
export function fitWidget(widget: WidgetInput): WidgetInput;
export function fitWidget(widget: WidgetInput): WidgetInput {
  const { query, chart } = widget;
  if (query.kind !== "sql") return { ...widget, chart: query.kind };
  if (!isMetricChart(chart)) return fitWidget({ ...widget, chart: "table" });
  if (!query.form) return widget;
  const form = chart === "number" ? { ...query.form, dimensions: [] } : query.form;
  return { ...widget, query: formQuery(form, chart, form.bucket ?? "hour") };
}

/** The widget a person starts from when they pick a kind: its filter stays where the kind has one. */
export function widgetOfKind(kind: WidgetKind, from: WidgetInput): WidgetInput {
  if (from.query.kind === kind) return from;
  const filters = queryFilter(from.query) ?? {};
  switch (kind) {
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
    case "sql":
      return { ...from, query: sqlWidgetQuery(NEW_SQL_TEXT), chart: "table" };
  }
}

/** The widget of a metric of the form: its selection, drawn as `chart`. */
export function formWidget(form: MetricForm, chart: MetricChartKind = "line"): MetricWidget {
  return fitWidget({ title: "", query: formQuery(form, chart, form.bucket ?? "hour"), chart });
}

/** The selection of a query object of kind metric: what a form widget holds. */
export function formOf({ version: _, kind: __, ...form }: MetricQuery): MetricForm {
  return form;
}

/** A query of kind sql in the RQL version of this build. */
export function sqlWidgetQuery(text: string): SqlQuery {
  return { version: QUERY_VERSION, kind: "sql", text, rqlVersion: RQL_VERSION };
}

/** What a new funnel starts from: the fewest steps it may have. */
const NEW_FUNNEL: readonly FunnelStep[] = [
  { name: "Called a tool", condition: { type: "attribute", path: "tools", op: "exists" } },
  { name: "No error", condition: { type: "no_error" } },
];

/** The catalog entry a query reads, or null for a kind without one. A Custom text reads none. */
export function queryMetric(query: Query): MetricDefinition | null {
  if (query.kind === "sql") return query.form ? getMetric(query.form.measures[0].measure) : null;
  return measuresOne(query) ? getMetric(query.measures[0].measure) : null;
}

/** A query's own trace filter, without its scorer: of a metric widget, its form's. */
export function queryFilter(query: Query): TraceFilter {
  if (query.kind === "clusters") return {};
  if (query.kind === "sql") return query.form ? queryFilter(metricOfForm(query.form)) : {};
  if (!measuresOne(query)) return query.filters;
  const { scorer: _, ...filter } = query.filters;
  return filter;
}

export function queryScorerId(query: Query): string | undefined {
  if (query.kind === "sql") return query.form?.filters.scorer?.id;
  return measuresOne(query) ? query.filters.scorer?.id : undefined;
}

/** The query object of kind metric of a selection: what the form compiler and an alert read. */
export function metricOfForm(form: MetricForm): MetricQuery {
  return { version: QUERY_VERSION, kind: "metric", ...form };
}

/** The kinds that show one measure of the catalog. */
export function measuresOne(query: Query): query is MetricQuery | GeographyQuery {
  return query.kind === "metric" || query.kind === "geography";
}

/** The query with another trace filter; its scorer stays. RQL text keeps its own. */
export function withFilter<Q extends Query>(query: Q, filter: TraceFilter): Q {
  if (query.kind === "clusters" || query.kind === "sql") return query;
  const scorer = queryScorerId(query);
  return { ...query, filters: { ...filter, ...(scorer ? { scorer: { id: scorer } } : {}) } };
}

/** Whether the dashboard's filters narrow it. */
export function isFilterable(query: Query): boolean {
  // RQL text has no filter of its own to take the page's: the page's filter applies when it runs.
  if (query.kind === "clusters" || query.kind === "sql") return false;
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

export function dimensionLabel(dimension: MetricDimension): string {
  return propertyOf(dimension) ?? DIMENSION_LABELS[dimension as Dimension];
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
  return formWidget(
    formOf(
      metricQuery(verdict ? "scorer_pass_rate" : "scorer_average", verdict ? "rate" : "avg", {
        filters: { scorer: { id } },
      }),
    ),
  );
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
export function widgetName({ title, query }: { title: string; query: Query }): string {
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
      return query.form ? metricName(query.form) : "RQL query";
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
  | { kind: "sql"; form?: Pick<MetricForm, "measures" | "dimensions"> };

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
  return `${label}${how}${dimensions.length > 0 ? ` by ${dimensions.map((dimension) => propertyOf(dimension) ?? dimension).join(" and ")}` : ""}`;
}
