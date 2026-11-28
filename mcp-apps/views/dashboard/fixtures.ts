import type { MetricQuery } from "@/lib/contracts/query";
import { foldStepFlow } from "@/lib/synthesis/metrics/step-flow-columns";
import type { MetricChartKind } from "@/lib/views/dashboards/types";
import { formOf, formWidget } from "@/lib/views/dashboards/widget";
import { seeded } from "../../harness/data";
import { okResult, type ViewFixtures } from "../../shell/types";
import type { DashboardModel, ViewWidget } from "./model";

/** A dashboard of every widget kind, as get_dashboard carries it for this view. */

const random = seeded(17);
const days = Array.from({ length: 30 }, (_, index) =>
  new Date(Date.parse("2026-10-13T00:00:00Z") + index * 86_400_000).toISOString(),
);
const around = (value: number) => Math.round(value * (0.7 + random() * 0.6) * 100) / 100;
const series = (name: string | null, value: number, total = value * days.length) => ({
  groups: name === null ? [] : [{ value: name }],
  total,
  samples: 900,
  values: days.map(() => around(value)),
});
const metric = (measure: string, aggregation: string, dimensions: string[] = []) => ({
  version: 1,
  kind: "metric",
  measures: [{ measure, aggregation }],
  dimensions,
  filters: {},
});
const numbers = (list: ReturnType<typeof series>[]) => ({
  kind: "metric",
  bucket: "day",
  buckets: days,
  series: list,
});
const MODELS = ["claude-sonnet-5-5", "gpt-5", "claude-haiku-5-5"];

function item(
  id: string,
  name: string,
  chart: string,
  query: object,
  result: object | null,
  [x, y, w, h]: readonly [number, number, number, number],
): ViewWidget {
  // A metric widget is RQL with the form's selection, as get_dashboard carries it.
  const metricQuery = query as MetricQuery;
  const widget =
    metricQuery.kind === "metric"
      ? formWidget(formOf(metricQuery), chart as MetricChartKind)
      : { title: "", query, chart };
  return { id, name, layout: { x, y, w, h }, widget, result } as ViewWidget;
}

/** Tool paths of two intents, with one tool that often fails. */
const STEP_NAMES = [
  "Refund an order",
  "No intent",
  "search_orders",
  "get_order",
  "refund_payment",
  "send_email",
  "search_kb",
];
const stepPaths = {
  names: STEP_NAMES,
  paths: [
    { start: 0, steps: [2, 3, 4, 5, 5], more: false, count: 120 },
    { start: 0, steps: [2, 3, 5], more: false, count: 90 },
    { start: 1, steps: [6, 5], more: false, count: 80 },
    { start: 1, steps: [2, 6], more: false, count: 60 },
    { start: 1, steps: [], more: false, count: 20 },
  ],
};

const { routes: _, ...STEP_FOLD } = foldStepFlow(stepPaths, { steps: 3, nodes: 7 });

/** One widget of each kind and chart, by name. */
export const KINDS: Readonly<Record<string, ViewWidget>> = {
  number: item(
    "number",
    "Traces",
    "number",
    metric("trace_count", "count"),
    numbers([series(null, 41, 1234)]),
    [0, 0, 3, 4],
  ),
  line: item(
    "line",
    "Latency p95 by model",
    "line",
    metric("latency", "p95", ["model"]),
    numbers(MODELS.map((name, index) => series(name, 2400 - index * 700, 2400 - index * 700))),
    [3, 0, 9, 8],
  ),
  bar: item(
    "bar",
    "Traces by model",
    "bar",
    metric("trace_count", "count", ["model"]),
    numbers(MODELS.map((name, index) => series(name, 40 - index * 12))),
    [0, 8, 6, 8],
  ),
  table: item(
    "table",
    "Cost by model",
    "table",
    metric("cost", "sum", ["model"]),
    numbers(MODELS.map((name, index) => series(name, 2, 42.5 - index * 11))),
    [6, 8, 6, 8],
  ),
  flow: item(
    "flow",
    "Tool flow",
    "flow",
    { version: 1, kind: "flow", node: "tool", steps: 5, edges: 50, filters: {} },
    {
      kind: "flow",
      edges: [
        { source: "search_orders", target: "get_order", step: 1, count: 320 },
        { source: "search_orders", target: "search_kb", step: 1, count: 90 },
        { source: "get_order", target: "refund_payment", step: 2, count: 180 },
        { source: "get_order", target: "send_email", step: 2, count: 110 },
        { source: "refund_payment", target: "send_email", step: 3, count: 150 },
      ],
      moreEdges: 0,
      sample: { matched: 420, read: 420 },
    },
    [0, 16, 7, 8],
  ),
  funnel: item(
    "funnel",
    "Funnel: Found the order to No error",
    "funnel",
    {
      version: 1,
      kind: "funnel",
      order: "in_order",
      steps: [
        { name: "Found the order", condition: { type: "tool", name: "get_order" } },
        { name: "Refunded", condition: { type: "tool", name: "refund_payment" } },
        { name: "No error", condition: { type: "no_error" } },
      ],
      filters: {},
    },
    {
      kind: "funnel",
      steps: [
        { name: "Found the order", count: 290, conversion: null },
        { name: "Refunded", count: 180, conversion: 180 / 290 },
        { name: "No error", count: 171, conversion: 171 / 180 },
      ],
      sample: { matched: 420, read: 420 },
    },
    [7, 16, 5, 8],
  ),
  clusters: item(
    "clusters",
    "Intent clusters",
    "clusters",
    { version: 1, kind: "clusters", view: "asks" },
    {
      kind: "clusters",
      view: "asks",
      model: {
        asks: ["Refund an order", "Where is my order", "Change the address"].map(
          (label, index) => ({
            id: `c${index}`,
            label,
            volume: 420 - index * 130,
            phrasings: 12,
            firstTry: null,
            rankedByGraph: 0,
            problem: null,
          }),
        ),
        capabilities: [],
        links: [],
        hidden: null,
      },
      steps: [],
      analyzedAt: "2026-11-10T06:00:00.000Z",
      names: { clusters: [], tools: [], skills: [], tasks: [] },
    },
    [0, 24, 5, 8],
  ),
  geography: item(
    "geography",
    "Traces by country",
    "geography",
    {
      version: 1,
      kind: "geography",
      measures: [{ measure: "trace_count", aggregation: "count" }],
      level: "world",
      filters: {},
    },
    {
      kind: "geography",
      places: [
        { code: "US", value: 610, samples: 610 },
        { code: "IT", value: 240, samples: 240 },
        { code: "DE", value: 130, samples: 130 },
        { code: "BR", value: 80, samples: 80 },
      ],
      located: { traces: 1060, matched: 1234 },
      resolvesAddresses: true,
    },
    [5, 24, 7, 8],
  ),
  step_flow: item(
    "step_flow",
    "Tool step flow by intent",
    "step_flow",
    {
      version: 1,
      kind: "step_flow",
      node: "tool",
      start: "intent",
      mode: "every_call",
      steps: 3,
      nodes: 7,
      filters: {},
    },
    {
      kind: "step_flow",
      ...STEP_FOLD,
      ...stepPaths,
      marks: [{ step: 3, name: "refund_payment", errors: true, slow: false }],
      sample: { matched: 370, read: 370 },
    },
    [0, 32, 12, 10],
  ),
  sql: item(
    "sql",
    "LLM calls by model",
    "sql",
    {
      version: 1,
      kind: "sql",
      text: "select model, count(*) as calls, sum(cost_usd) as cost from events where type = 'llm_call' group by model",
      rqlVersion: 1,
    },
    {
      kind: "sql",
      columns: [
        { name: "model", type: "text" },
        { name: "calls", type: "integer" },
        { name: "cost", type: "number" },
      ],
      rows: [
        ["claude-sonnet-5-5", 228, 1.525],
        ["claude-haiku-5-5", 64, 0.0812],
      ],
      truncated: false,
    },
    [0, 42, 12, 6],
  ),
};

/** What a host shows in place of a widget's numbers. */
export const FAULTS: Readonly<Record<string, ViewWidget>> = {
  broken: {
    id: "broken",
    name: "Old widget",
    layout: { x: 0, y: 0, w: 4, h: 6 },
    problem: 'Unknown measure "spans".',
    result: null,
  },
  missing: {
    ...KINDS.bar,
    id: "missing",
    name: "Scorer pass rate",
    layout: { x: 4, y: 0, w: 4, h: 6 },
    missingScorer: "Polite",
    result: null,
  },
  failed: { ...KINDS.line, id: "failed", layout: { x: 8, y: 0, w: 4, h: 6 }, result: null },
};

/** A funnel by plan (RTL-398): each value with its traces and its numbers in one line. */
const funnelOf = (count: number) => ({
  kind: "funnel",
  steps: [
    { name: "Found the order", count, conversion: null },
    { name: "Refunded", count: Math.round(count * 0.6), conversion: 0.6 },
  ],
  sample: { matched: count, read: count },
});
export const GROUPED: ViewWidget = item(
  "grouped",
  "Funnel by plan",
  "funnel",
  { ...KINDS.funnel.widget?.query, groupBy: { property: "plan" }, groupLimit: 3 },
  {
    kind: "grouped",
    by: { property: "plan" },
    leftOut: 2,
    groups: [
      { value: "pro", traces: 210, summary: "Found the order 210 > Refunded 126" },
      { value: "free", traces: 160, summary: "Found the order 160 > Refunded 96" },
      { value: null, traces: 50, summary: "Found the order 50 > Refunded 30" },
    ].map((group) => ({ ...group, result: funnelOf(group.traces) })),
  },
  [0, 0, 12, 8],
);

const window = { since: "2026-10-13T00:00:00.000Z", until: "2026-11-12T00:00:00.000Z" };
const HREF = "/project/11111111-1111-4111-8111-111111111111/dashboards/d1";

/** A get_dashboard result: the text every host gets, and this view's model. */
function dashboard(name: string, widgets: readonly ViewWidget[], withModel = true) {
  const model: DashboardModel & { kind: string } = {
    kind: "dashboard",
    projectId: "11111111-1111-4111-8111-111111111111",
    name,
    href: HREF,
    range: { preset: "30d", from: "2026-10-13", to: "2026-11-11" },
    filters: {},
    widgets: [...widgets],
  };
  return okResult(
    {
      dashboard: { id: "d1", name, widgetCount: widgets.length, href: HREF },
      widgets: widgets.map((widget) => ({
        id: widget.id,
        name: widget.name,
        layout: widget.layout,
        ...(widget.problem ? { problem: widget.problem } : { summary: "1,234 in 30 days" }),
      })),
    },
    { window, ...(withModel ? { view: model } : {}) },
  );
}

const everything = Object.values(KINDS);

const EXPLORE = "/project/11111111-1111-4111-8111-111111111111/explore?panels=1.W10";
const panels = [
  { ...KINDS.line, id: "panel-1", layout: { x: 0, y: 0, w: 6, h: 10 } },
  { ...KINDS.step_flow, id: "panel-2", layout: { x: 6, y: 0, w: 6, h: 10 } },
];
const compared = {
  name: "Explore",
  summary: "Latency p95 by model: 2.4 s",
  widgets: panels.map(({ id, name }) => ({
    id,
    name,
    summary: "claude-sonnet-5-5 2.4 s",
    result: {},
  })),
  href: EXPLORE,
};

const fixtures: ViewFixtures = {
  get_dashboard: { tool: "get_dashboard", result: dashboard("Support agent", everything) },
  "get_dashboard · needs attention": {
    tool: "get_dashboard",
    result: dashboard("Imported board", Object.values(FAULTS)),
  },
  "get_dashboard · empty": { tool: "get_dashboard", result: dashboard("New board", []) },
  "get_dashboard · text only": {
    tool: "get_dashboard",
    result: dashboard("Support agent", everything, false),
  },
  query_monitoring: {
    tool: "query_monitoring",
    result: okResult(
      { name: KINDS.line.name, summary: "claude-sonnet-5-5 2.4 s", result: {} },
      {
        window,
        view: {
          kind: "dashboard",
          projectId: "11111111-1111-4111-8111-111111111111",
          name: "Query",
          href: EXPLORE,
          range: { preset: "custom", from: "2026-10-13", to: "2026-11-12" },
          filters: {},
          widgets: [{ ...KINDS.line, id: "query", layout: { x: 0, y: 0, w: 12, h: 8 } }],
        },
      },
    ),
  },
  "query_monitoring · grouped": {
    tool: "query_monitoring",
    result: okResult(
      {
        name: GROUPED.name,
        summary: "By plan: pro (210 traces): Found the order 210 > Refunded 126",
        result: {},
      },
      {
        window,
        view: {
          kind: "dashboard",
          projectId: "11111111-1111-4111-8111-111111111111",
          name: "Query",
          href: EXPLORE,
          range: { preset: "custom", from: "2026-10-13", to: "2026-11-12" },
          filters: {},
          widgets: [{ ...GROUPED, id: "query" }],
        },
      },
    ),
  },
  "query_monitoring · two queries": {
    tool: "query_monitoring",
    result: okResult(compared, {
      window,
      view: {
        kind: "dashboard",
        projectId: "11111111-1111-4111-8111-111111111111",
        name: "Explore",
        href: EXPLORE,
        range: { preset: "custom", from: "2026-10-13", to: "2026-11-11" },
        filters: {},
        widgets: panels,
      },
    }),
  },
  "query_monitoring · two queries, text only": {
    tool: "query_monitoring",
    result: okResult(compared),
  },
  "query_monitoring · text only": {
    tool: "query_monitoring",
    result: okResult({ name: KINDS.line.name, summary: "claude-sonnet-5-5 2.4 s", result: {} }),
  },
};

export default fixtures;
