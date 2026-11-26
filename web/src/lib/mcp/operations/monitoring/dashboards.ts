import { z } from "zod";
import { MAX_FILTER_BYTES } from "@/lib/contracts/filter-budget";
import {
  BUCKETS,
  DIMENSIONS,
  MEASURES,
  QUERY_VERSION,
  type Query,
  querySchema,
  type SqlQuery,
} from "@/lib/contracts/query";
import { invalidParams, notFound } from "@/lib/mcp/errors";
import {
  callerAccess,
  defaultMonitoringDeps,
  type MonitoringCaller,
  type MonitoringDeps,
  observeChange,
  queryRefusal,
  refusal,
  required,
  requireMonitoring,
} from "@/lib/mcp/operations/monitoring/deps";
import { cappedResult, countOf, headline } from "@/lib/mcp/operations/monitoring/results";
import { projectScoped, uuidParam } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation, type OperationContext } from "@/lib/mcp/registry";
import { capRows, limitParam, TruncationTracker } from "@/lib/mcp/serialize";
import { resolveWindow, windowParams } from "@/lib/mcp/windows";
import { MAX_METRIC_WINDOW_DAYS, offeredMetrics } from "@/lib/synthesis/metrics/catalog";
import { RQL_LIMITS, RQL_VERSION } from "@/lib/synthesis/rql/compile";
import { resolveTraceRange } from "@/lib/synthesis/traces/view";
import { changeDashboard } from "@/lib/views/dashboards/actions";
import { loadWidgets } from "@/lib/views/dashboards/data";
import { dashboardDocumentSchema, exportDashboard } from "@/lib/views/dashboards/document";
import {
  dashboardFiltersSchema,
  defaultsSchema,
  filtersProblem,
} from "@/lib/views/dashboards/filters";
import { gridPositionSchema, inReadingOrder } from "@/lib/views/dashboards/layout";
import { type DashboardRange, dashboardHref, dashboardsHref } from "@/lib/views/dashboards/links";
import { exactly } from "@/lib/views/dashboards/range";
import * as store from "@/lib/views/dashboards/store";
import { isBroken } from "@/lib/views/dashboards/stored-widget";
import {
  type Dashboard,
  type DashboardSummary,
  type DashboardWidget,
  METRIC_CHARTS,
  SQL_WIDGET_PROBLEM,
  WIDGET_CHARTS,
  WIDGET_KINDS,
  type WidgetInput,
  type WidgetKind,
} from "@/lib/views/dashboards/types";
import { chartProblem, widgetName } from "@/lib/views/dashboards/widget";
import { explorePanelsHref } from "@/lib/views/explore/links";
import { MAX_PANELS } from "@/lib/views/explore/types";
import { scorerNames } from "@/lib/views/scorers/picker";

const FEATURES = { customMonitoring: true } as const;
const QUERY_WINDOW = { defaultDays: 7, maxDays: MAX_METRIC_WINDOW_DAYS } as const;
/** Kind sql reads at most the longest window of RQL. */
const SQL_WINDOW = { defaultDays: 7, maxDays: RQL_LIMITS.maxWindowDays } as const;
const SQL_CHART_PROBLEM = "A query of kind sql has no chart: it gives a table.";
/** How a change made through MCP is signed: the core has no table of people. */
const EDITOR_NAME = "An agent (MCP)";

const EXAMPLE_QUERY =
  'Example: {"version":1,"kind":"metric","measures":[{"measure":"latency","aggregation":"p95"}],"dimensions":["model"]}.';
const EXAMPLE_STEP_FLOW =
  'A step flow: {"version":1,"kind":"step_flow","node":"tool","start":"intent"}.';
const EXAMPLE_WIDGET =
  'Example: {"title":"Speed","chart":"line","query":{"version":1,"kind":"metric","measures":[{"measure":"latency","aggregation":"p95"}]}}.';
const EXAMPLE_DOCUMENT =
  'Example: {"type":"ratel.dashboard","version":1,"name":"Board","widgets":[{"chart":"number","query":{"version":1,"kind":"metric","measures":[{"measure":"trace_count","aggregation":"count"}]},"layout":{"x":0,"y":0,"w":6,"h":6}}]}.';

const dashboardIdParam = uuidParam().describe("A dashboard id from list_dashboards.");
const queryParam = z.record(z.string(), z.unknown());
const widgetParam = z.strictObject({
  title: z.string().max(80).optional().describe("Empty: the query's own name."),
  query: queryParam,
  chart: z
    .enum(WIDGET_CHARTS)
    .describe("line, bar, number or table for a metric; else the query's kind."),
});

/** A panel of the Explore page: a widget whose chart may be left out. */
const panelParam = widgetParam.partial({ chart: true });

/** One query of each kind, as an agent may write it. */
export const EXAMPLES = {
  metric: {
    version: QUERY_VERSION,
    kind: "metric",
    measures: [{ measure: "error_rate", aggregation: "rate" }],
    dimensions: ["model"],
    filters: { environments: ["production"] },
  },
  flow: { version: QUERY_VERSION, kind: "flow", node: "tool" },
  step_flow: { version: QUERY_VERSION, kind: "step_flow", node: "tool", start: "intent" },
  funnel: {
    version: QUERY_VERSION,
    kind: "funnel",
    steps: [
      { name: "Called a tool", condition: { type: "attribute", path: "tools", op: "exists" } },
      { name: "No error", condition: { type: "no_error" } },
    ],
  },
  clusters: { version: QUERY_VERSION, kind: "clusters", view: "asks" },
  geography: {
    version: QUERY_VERSION,
    kind: "geography",
    measures: [{ measure: "trace_count", aggregation: "count" }],
  },
} as const satisfies Record<WidgetKind, z.input<typeof querySchema>>;

/** Kind sql (RQL text), in the catalog. */
const SQL_KIND = {
  kind: "sql",
  charts: [],
  example: {
    version: QUERY_VERSION,
    kind: "sql",
    text: "select model, count(*) as calls from events where type = 'llm_call' group by model",
    rqlVersion: RQL_VERSION,
  },
  note: "RQL text. query_monitoring runs it and gives a table. A widget, a panel and an alert cannot hold it yet. describe_rql_schema gives the language. run_rql runs it with a table view.",
} as const;

export function dashboardReadOperations(
  deps: MonitoringDeps = defaultMonitoringDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "describe_monitoring_schema",
      domain: "observability",
      title: "Describe the monitoring schema",
      description:
        "How to write a query object and a dashboard document: their JSON Schemas, the measures with their aggregations and dimensions, the query kinds with one example each, and the charts. Call it before query_monitoring, change_dashboard, import_dashboard or change_alert.",
      keywords: ["query schema", "dashboard schema", "available measures"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        part: z
          .enum(["all", "catalog", "query", "dashboard"])
          .default("all")
          .describe("catalog: without the two schemas. query or dashboard: one schema alone."),
      }),
      async execute(ctx, { part }) {
        await requireMonitoring(deps, ctx);
        const has = (wanted: string) => part === "all" || part === wanted;
        return {
          data: {
            ...(has("catalog") ? { catalog: catalog() } : {}),
            ...(has("query") ? { query: jsonSchema(querySchema) } : {}),
            ...(has("dashboard") ? { dashboard: jsonSchema(dashboardDocumentSchema) } : {}),
          },
          hint: "In a query a scorer is its id ({id}, from list_scorers); in a dashboard document it is its name ({name}).",
        };
      },
    }),
    defineOperation({
      id: "query_monitoring",
      domain: "observability",
      title: "Query monitoring data",
      description:
        "Run one query object, or two to four side by side, over a time range: a metric (grouped or not), a flow, a step_flow (what traces do at each step, or before one node), a funnel, clusters or geography. The result's href opens the same in the web app's Explore page. The same query makes a widget or, as an ungrouped metric, an alert. Read plain spend with get_cost_by_day.",
      keywords: ["metric query", "chart data", "funnel query", "flow of tools", "steps of traces"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        query: queryParam
          .optional()
          .describe(
            `A query object. ${EXAMPLE_QUERY} ${EXAMPLE_STEP_FLOW} A query of kind sql (RQL text) gives a table. It cannot be a panel.`,
          ),
        queries: z
          .array(panelParam)
          .min(2)
          .max(MAX_PANELS)
          .optional()
          .describe("In place of query: two to four panels, shown side by side."),
        ...windowParams,
        filters: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("On top of the query's own: environments, services, models, agents (lists)."),
        chart: z
          .enum(METRIC_CHARTS)
          .optional()
          .describe("How a view draws the metric of query. Default: line."),
        limit: limitParam,
      }),
      async execute(ctx, params) {
        const caller = await requireMonitoring(deps, ctx);
        const { projectId } = caller;
        const sql = loneSql(params);
        if (sql) return sqlAnswer(deps, caller, sql, params);
        const panels = askedPanels(params);
        const filter = parsedFilters(params.filters);
        const tooLong = filtersProblem(
          panels.map(({ query }) => query),
          filter ?? {},
        );
        if (tooLong) throw invalidParams(tooLong, [{ path: "filters", message: tooLong }]);
        const window = resolveWindow(params, QUERY_WINDOW, deps.now());
        const results = await Promise.all(
          panels.map(({ query }) => deps.runQuery(projectId, query, { ...window, filter })),
        ).catch((error: unknown) => {
          throw queryRefusal(error);
        });
        const tracker = new TruncationTracker();
        tracker.mark(window.clamped);
        const range = rangeOf(exactly(window.since, window.until));
        const href = explorePanelsHref(projectId, panels, { filters: filter ?? {}, range });
        const shown = panels.map((widget, index) => ({
          name: widgetName(widget),
          summary: headline(widget.query, results[index]),
          result: cappedResult(widget.query, results[index], params.limit, tracker),
        }));
        const alone = params.queries === undefined;
        const ids = panels.map((_, index) => (alone ? "query" : `panel-${index + 1}`));
        return {
          data: {
            ...(alone
              ? shown[0]
              : {
                  name: "Explore",
                  summary: shown.map(({ name, summary }) => `${name}: ${summary}`).join("\n"),
                  widgets: shown.map((panel, index) => ({ id: ids[index], ...panel })),
                }),
            href,
          },
          truncated: tracker.value,
          window: window.toJSON(),
          hint: panels.every(({ query }) => query.kind === "clusters")
            ? "Clusters read the stored analysis: the window and the filters do not change them."
            : "change_dashboard (add_widget) keeps it as a widget; change_alert watches an ungrouped metric.",
          ...(ctx.forView
            ? {
                view: {
                  kind: VIEW_KIND,
                  projectId,
                  name: alone ? "Query" : "Explore",
                  href,
                  range,
                  filters: filter ?? {},
                  widgets: panels.map((widget, index) => ({
                    id: ids[index],
                    name: shown[index].name,
                    layout: alone ? WHOLE : panelCell(index, panels.length),
                    widget,
                    result: results[index],
                  })),
                },
              }
            : {}),
        };
      },
    }),
    defineOperation({
      id: "list_dashboards",
      domain: "observability",
      title: "List dashboards",
      description:
        "The project's custom dashboards: name, widget count, saved filters and time range, and who changed it last. get_dashboard reads one with its numbers; import_dashboard makes one from a document.",
      keywords: ["dashboards", "custom dashboards"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped, limit: limitParam }),
      async execute(ctx, params) {
        const { projectId } = await requireMonitoring(deps, ctx);
        const all = await store.listDashboards(projectId, deps.db());
        const tracker = new TruncationTracker();
        return {
          data: {
            summary: countOf(
              all.length,
              "dashboard",
              all.map(({ name, widgetCount }) => `${name} (${widgetCount} widgets)`),
            ),
            count: all.length,
            dashboards: tracker.take(capRows(all, params.limit)).map((dashboard) => ({
              ...listed(dashboard),
              href: dashboardHref(projectId, dashboard.id),
            })),
            href: dashboardsHref(projectId),
          },
          truncated: tracker.value,
          hint:
            all.length === 0
              ? "No dashboard yet. import_dashboard makes one; change_dashboard (create_starter) makes the traces overview."
              : "get_dashboard shows one dashboard's widgets and numbers.",
        };
      },
    }),
    defineOperation({
      id: "get_dashboard",
      domain: "observability",
      title: "Get a dashboard",
      description:
        "One dashboard: its document (the JSON that import_dashboard takes), each widget with its id, its place and its numbers in one line, and the widgets that need attention. query_monitoring reads one widget's numbers in full.",
      keywords: ["dashboard document", "export dashboard", "dashboard numbers"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        dashboardId: dashboardIdParam,
        ...windowParams,
        numbers: z
          .boolean()
          .default(true)
          .describe("false: the document and the widgets alone, without a read of the numbers."),
      }),
      async execute(ctx, params) {
        const { projectId } = await requireMonitoring(deps, ctx);
        const dashboard = await store.getDashboard(projectId, params.dashboardId, deps.db());
        if (!dashboard) throw notFound("dashboard");
        const window = dashboardWindow(dashboard, params, deps.now());
        const [scorers, results] = await Promise.all([
          scorerNames(projectId, deps.db()),
          params.numbers
            ? loadWidgets(
                projectId,
                dashboard.widgets,
                { ...window, filter: dashboard.filters },
                FEATURES,
                deps.loadWidget,
              )
            : dashboard.widgets.map(() => null),
        ]);
        const widgets = dashboard.widgets.map((widget, index) => ({
          widget,
          result: results[index],
        }));
        return {
          data: {
            summary: [
              `${dashboard.name}: ${dashboard.widgets.length} widgets.`,
              ...widgets.flatMap(({ widget, result }) =>
                isBroken(widget)
                  ? [`${widget.title} needs attention: ${widget.problem}`]
                  : params.numbers
                    ? [`${widgetName(widget)}: ${headline(widget.query, result)}.`]
                    : [],
              ),
            ].join("\n"),
            dashboard: { ...listedWhole(dashboard), href: dashboardHref(projectId, dashboard.id) },
            widgets: widgets.map(({ widget, result }) => ({
              ...shownWidget(widget),
              ...(params.numbers && !isBroken(widget)
                ? { summary: headline(widget.query, result) }
                : {}),
            })),
            document: exportDashboard(dashboard, scorers),
            leftOut: dashboard.widgets.filter(isBroken).length,
          },
          window: {
            since: window.since.toISOString(),
            until: window.until.toISOString(),
          },
          truncated: window.clamped,
          hint: "Pass a widget's id as widgetId to change_dashboard. query_monitoring reads one widget's numbers in full.",
          ...(ctx.forView
            ? {
                view: {
                  kind: VIEW_KIND,
                  projectId,
                  name: dashboard.name,
                  range: window.range,
                  href: dashboardHref(projectId, dashboard.id),
                  filters: dashboard.filters,
                  widgets: widgets.map(({ widget, result }) => ({
                    ...shownWidget(widget),
                    ...(isBroken(widget)
                      ? {}
                      : {
                          widget: {
                            title: widget.title,
                            query: widget.query,
                            chart: widget.chart,
                          },
                          missingScorer: widget.missingScorer,
                        }),
                    result,
                  })),
                },
              }
            : {}),
        };
      },
    }),
  ];
}

export function dashboardWriteOperations(
  deps: MonitoringDeps = defaultMonitoringDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "change_dashboard",
      domain: "writes",
      title: "Change a dashboard",
      description:
        "Create, rename or delete a dashboard, set its filters and time range, or add, change, move or remove a widget. A scorer in a widget's query is its id. Make a whole dashboard in one call with import_dashboard; read widget ids with get_dashboard.",
      keywords: ["create dashboard", "add widget", "move widget"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        action: z.enum([
          "create",
          "create_starter",
          "rename",
          "delete",
          "set_filters",
          "add_widget",
          "change_widget",
          "move_widgets",
          "remove_widget",
        ]),
        dashboardId: dashboardIdParam.optional().describe("Every action but the two creates."),
        name: z.string().max(200).optional().describe("For create and rename."),
        filters: dashboardFiltersSchema
          .optional()
          .describe("For set_filters: replaces them. {} removes them."),
        range: defaultsSchema.shape.range
          .optional()
          .describe("For set_filters. Null: the console's default."),
        widgetId: z.string().max(100).optional().describe("For change_widget and remove_widget."),
        widget: widgetParam
          .partial()
          .optional()
          .describe(`For add_widget (query and chart) and change_widget. ${EXAMPLE_WIDGET}`),
        layout: gridPositionSchema
          .optional()
          .describe("For add_widget: a place on 12 columns. Absent: the first free place."),
        layouts: z
          .record(z.string(), gridPositionSchema)
          .optional()
          .describe('For move_widgets: {"<widgetId>":{"x":0,"y":0,"w":6,"h":6}}.'),
      }),
      async execute(ctx, params) {
        const { dashboardId } = await run(deps, ctx, (projectId) =>
          changeOf(params, projectId, deps),
        );
        return saved(deps, ctx, params.action, dashboardId);
      },
    }),
    defineOperation({
      id: "import_dashboard",
      domain: "writes",
      title: "Import a dashboard",
      description:
        "Make a dashboard, with all of its widgets, from one document: the JSON that get_dashboard returns, or one you write. A scorer is given by its name. A refusal names the widget that is wrong. describe_monitoring_schema has the document's schema.",
      keywords: ["import dashboard", "dashboard from json", "build a dashboard"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        document: z
          .record(z.string(), z.unknown())
          .describe(`A dashboard document. ${EXAMPLE_DOCUMENT}`),
      }),
      async execute(ctx, params) {
        const { dashboardId, missingScorers } = await run(deps, ctx, async () => ({
          action: "import",
          document: params.document,
        }));
        const result = await saved(deps, ctx, "import", dashboardId);
        return {
          ...result,
          data: { ...result.data, missingScorers: missingScorers ?? [] },
          hint: missingScorers?.length
            ? `Scorers this project does not have: ${missingScorers.join(", ")}. Their widgets show no numbers until change_widget gives them another scorer.`
            : result.hint,
        };
      },
    }),
  ];
}

/** What the dashboard view (mcp-apps/views/dashboard) knows its own model by. */
const VIEW_KIND = "dashboard";
/** A result drawn alone fills the grid. */
const WHOLE = { x: 0, y: 0, w: 12, h: 8 } as const;

/** A panel's place: two in a row, and the last of an odd number fills its row. */
function panelCell(index: number, count: number) {
  const last = index === count - 1 && count % 2 === 1;
  return { x: (index % 2) * 6, y: Math.floor(index / 2) * 10, w: last ? 12 : 6, h: 10 };
}

interface QueryParams {
  query?: unknown;
  queries?: readonly unknown[];
  since?: string;
  until?: string;
  filters?: unknown;
  chart?: string;
  limit: number;
}

/** The query of kind sql a call asks for alone, or undefined for any other call. */
function loneSql(params: QueryParams): SqlQuery | undefined {
  if (params.queries !== undefined) return undefined;
  const raw = params.query as { kind?: unknown } | undefined;
  if (raw?.kind !== "sql") return undefined;
  return parsedQuery(raw, ["query"]) as SqlQuery;
}

/** A query of kind sql: its table, with the errors of RQL. */
async function sqlAnswer(
  deps: MonitoringDeps,
  { projectId }: MonitoringCaller,
  query: SqlQuery,
  params: QueryParams,
) {
  if (params.chart)
    throw invalidParams(SQL_CHART_PROBLEM, [{ path: "chart", message: SQL_CHART_PROBLEM }]);
  const window = resolveWindow(params, SQL_WINDOW, deps.now());
  const filter = parsedFilters(params.filters);
  const result = await deps
    .runQuery(projectId, query, { since: window.since, until: window.until, filter })
    .catch((error: unknown) => {
      throw queryRefusal(error);
    });
  const tracker = new TruncationTracker();
  tracker.mark(window.clamped);
  return {
    data: {
      name: "RQL query",
      summary: headline(query, result),
      result: cappedResult(query, result, params.limit, tracker),
    },
    truncated: tracker.value,
    window: window.toJSON(),
    hint: "run_rql runs RQL too, and shows the table as a view. A widget cannot hold kind sql yet.",
  };
}

/** The panels a call asks for, each with the chart it is drawn as. */
function askedPanels(params: {
  query?: unknown;
  queries?: readonly z.infer<typeof panelParam>[];
  chart?: WidgetInput["chart"];
}): WidgetInput[] {
  if ((params.query === undefined) === (params.queries === undefined))
    throw invalidParams("Pass query, or queries for two to four panels: one of them.", [
      { path: "query", message: "Pass query or queries." },
    ]);
  if (params.queries && params.chart)
    throw invalidParams("With queries, give each panel its own chart.", [
      { path: "chart", message: "Each panel of queries has its own chart." },
    ]);
  const asked = params.queries
    ? params.queries.map((panel, index) => ({ ...panel, path: ["queries", String(index)] }))
    : [{ title: "", query: params.query, chart: params.chart, path: [] }];
  return asked.map(({ title = "", query: raw, chart: given, path }) => {
    const query = parsedQuery(raw, [...path, "query"]);
    if (query.kind === "sql")
      throw invalidParams(SQL_WIDGET_PROBLEM, [
        { path: [...path, "query", "kind"].join("."), message: SQL_WIDGET_PROBLEM },
      ]);
    // The chart of a lone query is for a metric; the other kinds have one each.
    const chart =
      query.kind === "metric" ? (given ?? "line") : path.length > 0 && given ? given : query.kind;
    const problem = chartProblem({ chart, query });
    if (problem)
      throw invalidParams(problem, [{ path: [...path, "chart"].join("."), message: problem }]);
    return { title: title.trim(), query, chart };
  });
}

interface DashboardParams {
  action: string;
  dashboardId?: string;
  name?: string;
  filters?: Dashboard["filters"];
  range?: Dashboard["range"];
  widgetId?: string;
  widget?: Record<string, unknown>;
  layout?: unknown;
  layouts?: unknown;
}

/** The tool's params as the console's own change. */
async function changeOf(params: DashboardParams, projectId: string, deps: MonitoringDeps) {
  const { action } = params;
  if (action === "create") return { action, name: required(params.name, "name", action) };
  if (action === "create_starter") return { action: "create-starter" };
  const dashboardId = required(params.dashboardId, "dashboardId", action);
  const current = () => storedDashboard(projectId, dashboardId, deps);
  switch (action) {
    case "rename":
      return { action, dashboardId, name: required(params.name, "name", action) };
    case "set_filters": {
      if (params.filters === undefined && params.range === undefined)
        throw invalidParams("Pass filters or range to set_filters.");
      const { filters, range } = await current();
      const defaults = {
        filters: params.filters ?? filters,
        range: params.range === undefined ? range : params.range,
      };
      return { action: "save-defaults", dashboardId, defaults };
    }
    case "add_widget":
      return {
        action: "add-widget",
        dashboardId,
        widget: required(params.widget, "widget", action),
        layout: params.layout,
      };
    case "change_widget": {
      const widgetId = required(params.widgetId, "widgetId", action);
      const given = required(params.widget, "widget", action);
      const widget = (await current()).widgets.find(({ id }) => id === widgetId);
      if (!widget) throw notFound("widget");
      const own = isBroken(widget)
        ? {}
        : { title: widget.title, query: widget.query, chart: widget.chart };
      return { action: "edit-widget", dashboardId, widgetId, widget: { ...own, ...given } };
    }
    case "move_widgets":
      return {
        action: "save-layout",
        dashboardId,
        layouts: required(params.layouts, "layouts", action),
      };
    case "remove_widget":
      return {
        action: "remove-widget",
        dashboardId,
        widgetId: required(params.widgetId, "widgetId", action),
      };
    default:
      return { action, dashboardId };
  }
}

/** One change through the console's own action. */
async function run(
  deps: MonitoringDeps,
  ctx: OperationContext,
  change: (projectId: string) => Promise<object>,
) {
  const caller = await requireMonitoring(deps, ctx);
  const db = deps.db();
  const result = await changeDashboard(
    { ...(await change(caller.projectId)), projectId: caller.projectId },
    {
      ...callerAccess(ctx, caller),
      getSession: async () => ({
        user: {
          id: caller.actor,
          externalId: caller.actor,
          name: EDITOR_NAME,
          username: null,
          email: EDITOR_NAME,
        },
      }),
      features: async () => FEATURES,
      scorers: (projectId) => scorerNames(projectId, db),
      store: {
        createDashboard: (input) => store.createDashboard(input, db),
        updateDashboard: (input) => store.updateDashboard(input, db),
        deleteDashboard: (projectId, id) => store.deleteDashboard(projectId, id, db),
        changeWidgets: (input) => store.changeWidgets(input, db),
      },
      observe: observeChange(deps, ctx, "dashboard_changed"),
    },
  );
  if (!result.ok) throw refusal(result.error);
  return result;
}

async function saved(
  deps: MonitoringDeps,
  ctx: OperationContext,
  action: string,
  dashboardId: string,
) {
  const dashboard = await store.getDashboard(ctx.projectId, dashboardId, deps.db());
  return {
    data: {
      action,
      dashboardId,
      ...(dashboard
        ? {
            dashboard: listedWhole(dashboard),
            widgets: inReadingOrder(dashboard.widgets).map(shownWidget),
            href: dashboardHref(ctx.projectId, dashboardId),
          }
        : {}),
    },
    hint: dashboard
      ? "get_dashboard shows it with its numbers."
      : "The dashboard is gone. list_dashboards lists the others.",
  };
}

async function storedDashboard(projectId: string, id: string, deps: MonitoringDeps) {
  const dashboard = await store.getDashboard(projectId, id, deps.db());
  if (!dashboard) throw notFound("dashboard");
  return dashboard;
}

/** The given window, else what the dashboard opens with. */
function dashboardWindow(
  { range }: Pick<Dashboard, "range">,
  params: { since?: string; until?: string },
  now: Date,
): { since: Date; until: Date; clamped: boolean; range: DashboardRange } {
  if (params.since || params.until) {
    const { since, until, clamped } = resolveWindow(params, QUERY_WINDOW, now);
    return { since, until, clamped, range: rangeOf(exactly(since, until)) };
  }
  const { since, until, preset, from, to } = resolveTraceRange({ range: range ?? undefined }, now);
  return { since, until, clamped: false, range: { preset, from, to } };
}

function rangeOf({ preset, from, to }: DashboardRange): DashboardRange {
  return { preset, from, to };
}

function listed({
  id,
  name,
  widgetCount,
  filters,
  range,
  updatedAt,
  updatedByName,
}: DashboardSummary) {
  return {
    id,
    name,
    widgetCount,
    filters,
    range,
    updatedAt: updatedAt.toISOString(),
    updatedBy: updatedByName,
  };
}

function listedWhole(dashboard: Dashboard) {
  const { widgets } = dashboard;
  return {
    ...listed({ ...dashboard, widgetCount: widgets.length }),
    needAttention: widgets.filter(isBroken).length,
  };
}

function shownWidget(widget: DashboardWidget) {
  const { id, layout } = widget;
  if (isBroken(widget)) return { id, name: widget.title, layout, problem: widget.problem };
  return {
    id,
    name: widgetName(widget),
    kind: widget.query.kind,
    chart: widget.chart,
    layout,
    ...(widget.missingScorer
      ? { problem: `The project has no scorer "${widget.missingScorer}".` }
      : {}),
  };
}

/** Every issue with its path, which the action's one sentence leaves out. */
function parsedQuery(raw: unknown, at: readonly string[]): Query {
  const parsed = querySchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map(({ path, message }) => ({
    path: [...at, ...path].join("."),
    message,
  }));
  throw invalidParams(
    `The query is invalid at "${issues[0].path}": ${issues[0].message}`,
    issues.slice(0, 10),
  );
}

function parsedFilters(raw: unknown): Dashboard["filters"] | undefined {
  if (raw === undefined) return undefined;
  const parsed = dashboardFiltersSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const [{ path, message }] = parsed.error.issues;
  const at = ["filters", ...path].join(".");
  throw invalidParams(`The filters are invalid at "${at}": ${message}`, [{ path: at, message }]);
}

function catalog() {
  return {
    kinds: [
      ...WIDGET_KINDS.map((kind) => ({
        kind,
        charts: kind === "metric" ? METRIC_CHARTS : [kind],
        example: EXAMPLES[kind],
      })),
      SQL_KIND,
    ],
    measures: offeredMetrics(FEATURES).map(
      ({ id, label, description, unit, aggregations, dimensions, buckets, filterable }) => ({
        id,
        label,
        description,
        unit,
        aggregations,
        dimensions,
        buckets,
        filterable,
        byScorer: MEASURES[id].byScorer,
      }),
    ),
    dimensions: DIMENSIONS,
    buckets: BUCKETS,
    rules: [
      "A filter is a list of clauses that must all match: its own properties, then each one of and. Two clauses on one property both hold, so {models:[a],and:[{models:[b]}]} keeps the traces that used a and b.",
      `All clauses of a filter, together with the filters of the dashboard or of query_monitoring, are ${MAX_FILTER_BYTES.toLocaleString("en-US")} bytes of JSON at most, so that View traces can always carry them.`,
      "A table needs a dimension. A number has none.",
      "An alert takes a metric query without dimensions. It reads what became known in its window: a trace when it ends, a scorer result when it is stored, so a trace longer than the window counts. A count or a sum of nothing is 0, so trace_count below 10 alerts on silence; a rate, an average or a percentile of nothing is no_data.",
      "A geography query reads where each trace came from. get_location_attributes has the span attributes it is read from; change_location_attributes changes them (organization admins).",
      "A layout is x, y, w and h on 12 columns. Overlaps and gaps are closed.",
    ],
  };
}

function jsonSchema(schema: z.ZodType): object {
  return z.toJSONSchema(schema, { io: "input", reused: "ref" });
}
