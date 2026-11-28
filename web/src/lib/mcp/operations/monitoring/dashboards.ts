import { z } from "zod";
import { MAX_FILTER_BYTES } from "@/lib/contracts/filter-budget";
import {
  BUCKETS,
  DIMENSIONS,
  GROUP_LIMITS,
  MEASURES,
  QUERY_KINDS,
  QUERY_VERSION,
  type Query,
  type QueryKind,
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
import {
  cappedResult,
  countOf,
  groupSummaries,
  headline,
  viewResult,
} from "@/lib/mcp/operations/monitoring/results";
import { RQL_WINDOW } from "@/lib/mcp/operations/monitoring/rql";
import { projectScoped, uuidParam } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation, type OperationContext } from "@/lib/mcp/registry";
import { capRows, limitParam, TruncationTracker } from "@/lib/mcp/serialize";
import { resolveWindow, windowParams } from "@/lib/mcp/windows";
import {
  getMetric,
  MAX_METRIC_WINDOW_DAYS,
  metricBucket,
  nothingIsZero,
  offeredMetrics,
  type QueryWindow,
} from "@/lib/synthesis/metrics/catalog";
import { RQL_VERSION } from "@/lib/synthesis/rql/compile";
import { resolveTraceRange } from "@/lib/synthesis/traces/view";
import { followDashboardChange } from "@/lib/views/ask/store";
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
import { formQuery } from "@/lib/views/dashboards/metric-rql";
import { exactly } from "@/lib/views/dashboards/range";
import { formAsMetric, sqlResultNotes } from "@/lib/views/dashboards/sql-chart";
import * as store from "@/lib/views/dashboards/store";
import { isBroken } from "@/lib/views/dashboards/stored-widget";
import { DASHBOARD_TEMPLATES } from "@/lib/views/dashboards/templates";
import { loadTemplateFacts, templateData } from "@/lib/views/dashboards/templates/data";
import {
  ensureDefaultDashboards,
  templateActionDeps,
} from "@/lib/views/dashboards/templates/store";
import {
  type Dashboard,
  type DashboardSummary,
  type DashboardWidget,
  METRIC_CHARTS,
  type MetricChartKind,
  STORED_CHARTS,
  type WidgetChart,
  type WidgetInput,
  type WidgetResult,
} from "@/lib/views/dashboards/types";
import {
  chartProblem,
  formOf,
  formWidget,
  isMetricChart,
  metricOfForm,
  queryName,
  widgetName,
} from "@/lib/views/dashboards/widget";
import { explorePanelsHref } from "@/lib/views/explore/links";
import { MAX_PANELS } from "@/lib/views/explore/types";
import { scorerNames } from "@/lib/views/scorers/picker";

const FEATURES = { customMonitoring: true } as const;
const QUERY_WINDOW = { defaultDays: 7, maxDays: MAX_METRIC_WINDOW_DAYS } as const;
/** Kind sql reads the window of RQL: its default and its longest window, as `run_rql`. */
const SQL_WINDOW = RQL_WINDOW;
/** How a change made through MCP is signed: the core has no table of people. */
const EDITOR_NAME = "An agent (MCP)";

const EXAMPLE_QUERY =
  'Example: {"version":1,"kind":"metric","measures":[{"measure":"latency","aggregation":"p95"}],"dimensions":["model"]}.';
const EXAMPLE_STEP_FLOW =
  'A step flow: {"version":1,"kind":"step_flow","node":"tool","start":"intent"}; one small chart per task: add "groupBy":"task".';
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
    .enum(STORED_CHARTS)
    .describe(
      "line, bar, number or table for a metric or RQL (kind sql: its rows decide which ones draw); else the query's kind. A metric widget is kept as RQL: kind sql with its form.",
    ),
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
} as const satisfies Record<Exclude<QueryKind, "sql">, z.input<typeof querySchema>>;

const SQL_PANEL_PROBLEM =
  "A query of kind sql cannot be a panel: ask it alone, or keep it as a widget with change_dashboard.";

/** Kind sql in the catalog. */
const SQL_KIND = {
  kind: "sql",
  example: {
    version: QUERY_VERSION,
    kind: "sql",
    text: "select model, count(*) as calls from events where type = 'llm_call' group by model",
    rqlVersion: RQL_VERSION,
  },
  charts: METRIC_CHARTS,
  note: "RQL text: what every metric widget is. query_monitoring runs it and gives a table. A widget draws its rows as a line or a bar (one time column, or a text column for bars, and numbers), a number (one row, one number) or a table (any rows). form is the metric form's selection that wrote the text; without it the text is Custom. A widget given as kind metric is kept as kind sql with its form. The dashboard's filter keeps the rows whose trace matches. A panel cannot hold it. describe_rql_schema gives the language. run_rql runs it with a table view.",
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
            `A query object. ${EXAMPLE_QUERY} ${EXAMPLE_STEP_FLOW} A query of kind sql (RQL text) gives a table. It cannot be a panel, but it can be a widget of chart sql.`,
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
          .describe(
            "On top of the query's own: environments, services, models, agents (lists), and properties (indexed trace properties, by name: a list of values each).",
          ),
        chart: z
          .enum(METRIC_CHARTS)
          .optional()
          .describe("How a view draws the metric of query. Default: line."),
        limit: limitParam,
        as: z
          .enum(["sql"])
          .optional()
          .describe(
            "sql: for a lone metric query, give the RQL text of its numbers instead of running it: the query of kind sql, with the form, that a metric widget keeps.",
          ),
      }),
      async execute(ctx, params) {
        const caller = await requireMonitoring(deps, ctx);
        const { projectId } = caller;
        if (params.as === "sql") return editAsSql(deps, params);
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
        const href = explorePanelsHref(projectId, panels.map(asWidget), {
          filters: filter ?? {},
          range,
        });
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
                    result: viewResult(widget.query, results[index]),
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
        // A project gets Tools, Cost and Reliability one time, where its list is read.
        await ensureDefaultDashboards(projectId, deps.db());
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
              ? "No dashboard yet. import_dashboard makes one from a document or a template (list_dashboard_templates)."
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
        const caller = await requireMonitoring(deps, ctx);
        const { projectId } = caller;
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
                    ? [
                        `${widgetName(widget)}: ${widgetHeadline(widget, result, window).replace(/\.$/, "")}.`,
                      ]
                    : [],
              ),
            ].join("\n"),
            dashboard: { ...listedWhole(dashboard), href: dashboardHref(projectId, dashboard.id) },
            widgets: widgets.map(({ widget, result }) => ({
              ...shownWidget(widget),
              ...(params.numbers && !isBroken(widget)
                ? {
                    summary: widgetHeadline(widget, result, window),
                    // A group-by: each value with its traces and its numbers in one line.
                    ...(result?.kind === "grouped"
                      ? {
                          groups: groupSummaries(widget.query, result),
                          leftOutValues: result.leftOut,
                        }
                      : {}),
                  }
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
                    result: isBroken(widget) ? result : viewResult(widget.query, result),
                  })),
                },
              }
            : {}),
        };
      },
    }),
  ];
}

/**
 * The dashboard templates (decision `dashboard-templates`): listed only with `customMonitoring` on,
 * as the RQL tools. import_dashboard makes a dashboard from one.
 */
export function dashboardTemplateOperations(
  deps: MonitoringDeps = defaultMonitoringDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "list_dashboard_templates",
      domain: "observability",
      title: "List dashboard templates",
      description:
        "The dashboard templates: id, name, what each one shows, the data it needs, and whether this project has that data (with what is missing). import_dashboard with template makes a normal dashboard from one.",
      keywords: ["dashboard templates", "template gallery", "default dashboards"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        const { projectId } = await requireMonitoring(deps, ctx);
        const facts = await loadTemplateFacts(projectId, deps.db());
        const templates = DASHBOARD_TEMPLATES.map((template) => {
          const { has, missing } = templateData(template, facts);
          return {
            id: template.id,
            name: template.name,
            description: template.description,
            needs: template.needs,
            ...(template.property ? { takes: "property" } : {}),
            hasData: has,
            missing,
          };
        });
        return {
          data: {
            summary: countOf(
              templates.length,
              "template",
              templates.map(({ name, hasData }) => `${name}${hasData ? "" : " (no data yet)"}`),
            ),
            templates,
            indexedProperties: facts.properties,
          },
          hint: 'import_dashboard with {"template":"<id>"} makes one. by-customer also takes "property": the name of an indexed trace property (indexedProperties).',
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
          .describe(
            "For set_filters: replaces them. {} removes them. properties narrows every widget by indexed trace properties, by name.",
          ),
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
        "Make a dashboard, with all of its widgets, from one document (the JSON that get_dashboard returns, or one you write) or from a template of list_dashboard_templates. A scorer is given by its name. A refusal names the widget that is wrong. describe_monitoring_schema has the document's schema.",
      keywords: ["import dashboard", "dashboard from json", "build a dashboard"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        document: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(`A dashboard document. ${EXAMPLE_DOCUMENT} Pass document or template.`),
        template: z
          .string()
          .max(80)
          .optional()
          .describe("A template id from list_dashboard_templates, instead of a document."),
        property: z
          .string()
          .max(200)
          .optional()
          .describe("For the template by-customer: the name of an indexed trace property."),
      }),
      async execute(ctx, params) {
        if ((params.document === undefined) === (params.template === undefined))
          throw invalidParams("Pass a document or a template, not both.");
        const action = params.template === undefined ? "import" : "create-template";
        const { dashboardId, missingScorers } = await run(deps, ctx, async () =>
          params.template === undefined
            ? { action, document: params.document }
            : { action, template: params.template, property: params.property },
        );
        const result = await saved(deps, ctx, action, dashboardId);
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
  as?: "sql";
  query?: unknown;
  queries?: readonly unknown[];
  since?: string;
  until?: string;
  filters?: unknown;
  chart?: string;
  limit: number;
}

/**
 * The RQL text that gives the numbers of a lone metric query, as the web app's metric form writes
 * it, with the bucket the query reads over the window: the query of kind sql, with its form, that
 * a metric widget keeps. Not run.
 */
async function editAsSql(deps: MonitoringDeps, params: QueryParams) {
  if (params.queries !== undefined)
    throw invalidParams(AS_SQL_PROBLEM, [{ path: "queries", message: AS_SQL_PROBLEM }]);
  const query = parsedQuery(params.query, ["query"]);
  if (query.kind !== "metric")
    throw invalidParams(AS_SQL_PROBLEM, [{ path: "query.kind", message: AS_SQL_PROBLEM }]);
  const chart = (params.chart ?? "line") as MetricChartKind;
  const problem = panelChartProblem({ query, chart });
  if (problem) throw invalidParams(problem, [{ path: "chart", message: problem }]);
  const window = resolveWindow(params, QUERY_WINDOW, deps.now());
  const metric = getMetric(query.measures[0].measure);
  const bucket = query.bucket ?? (metric ? metricBucket(metric, window) : "day");
  const sqlQuery = formQuery(formOf(query), chart, bucket);
  const name = queryName(query);
  return {
    data: {
      name,
      summary: `The RQL text of ${name}, by ${bucket}.`,
      text: sqlQuery.text,
      query: sqlQuery,
    },
    window: window.toJSON(),
    hint: "query_monitoring runs this query; change_dashboard (add_widget, with a chart) keeps it as a widget. The page filter of a dashboard applies to it as it runs.",
  };
}

const AS_SQL_PROBLEM = 'as "sql" takes one query of kind metric, alone.';

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
    hint: "run_rql runs RQL too, and shows the table as a view. change_dashboard (add_widget, chart line, bar, number or table) keeps it as a widget.",
  };
}

/** A panel of query_monitoring: a query as an agent asks it, with the chart it is drawn as. */
interface Panel {
  title: string;
  query: Query;
  chart: WidgetChart;
}

/** The panels a call asks for, each with the chart it is drawn as. */
function askedPanels(params: {
  query?: unknown;
  queries?: readonly z.infer<typeof panelParam>[];
  chart?: string;
}): Panel[] {
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
      throw invalidParams(SQL_PANEL_PROBLEM, [
        { path: [...path, "query", "kind"].join("."), message: SQL_PANEL_PROBLEM },
      ]);
    // The chart of a lone query is for a metric; the other kinds have one each.
    const chart = (
      query.kind === "metric" ? (given ?? "line") : path.length > 0 && given ? given : query.kind
    ) as WidgetChart;
    const problem = panelChartProblem({ chart, query });
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
      templates: templateActionDeps(db),
      store: {
        createDashboard: (input) => store.createDashboard(input, db),
        updateDashboard: (input) => store.updateDashboard(input, db),
        deleteDashboard: (projectId, id) => store.deleteDashboard(projectId, id, db),
        changeWidgets: (input) => store.changeWidgets(input, db),
      },
      observe: observeChange(deps, ctx, "dashboard_changed"),
      // Ask in words: a change to a dashboard that an ask made sets the ask's outcome.
      afterChange: (change) => followDashboardChange(change, deps.now(), db),
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

/** A widget's numbers in one line: a metric widget of the form says them as its metric does. */
function widgetHeadline(
  widget: WidgetInput,
  result: WidgetResult | null,
  window: QueryWindow,
): string {
  const { query, chart } = widget;
  if (!(query.kind === "sql" && query.form && result?.kind === "sql" && isMetricChart(chart)))
    return headline(query, result);
  const metric = metricOfForm(query.form);
  const drawn = formAsMetric(result, query.form, chart, window);
  const timed = chart === "line" || chart === "bar";
  // A text cut at the row cap says so, as the console does under the chart.
  const notes = sqlResultNotes(result)
    .map((note) => ` ${note}`)
    .join("");
  // A text by bucket gives no total for a rate, an average or a percentile: say its latest bucket.
  if (!timed || nothingIsZero(metric.measures[0].aggregation))
    return `${headline(metric, drawn)}${notes}`;
  const latest = {
    ...drawn,
    series: drawn.series.map((series) => ({
      ...series,
      total: series.values.findLast((value) => value !== null) ?? null,
    })),
  };
  return `${headline(metric, latest)} (the latest ${drawn.bucket} with a value)${notes}`;
}

/** Why a panel's chart does not fit its query: a metric as the form draws it, else its widget's rule. */
function panelChartProblem({ chart, query }: { chart: WidgetChart; query: Query }): string | null {
  if (query.kind !== "metric") return chartProblem({ chart, query });
  if (!isMetricChart(chart)) return `A metric cannot be drawn as a ${chart}.`;
  if (chart === "number" && query.dimensions.length > 0) return "A number cannot be grouped.";
  return null;
}

/** A panel as the console's widget: a metric becomes RQL with its form, as a widget keeps it. */
function asWidget({ title, query, chart }: Panel): WidgetInput {
  if (query.kind !== "metric") return { title, query, chart };
  return { ...formWidget(formOf(query), chart as MetricChartKind), title };
}

function catalog() {
  return {
    kinds: [
      ...QUERY_KINDS.filter((kind) => kind !== "sql").map((kind) => ({
        kind,
        charts: kind === "metric" ? METRIC_CHARTS : [kind],
        example: EXAMPLES[kind],
        ...(kind === "metric"
          ? {
              note: "A widget keeps a metric as RQL: kind sql, with this query as its form (query_monitoring as sql gives it).",
            }
          : {}),
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
      'A trace property that the project indexes filters any query: filters.properties, such as {"properties":{"organization":["acme"]}} (any value of a name; names combine). A metric of traces or of scores groups by one: {"property":"organization"} in dimensions. list_trace_properties gives the names; one that is not indexed is refused with property_not_indexed. user, session, environment, model and service are built-in fields, not properties.',
      'A flow, step_flow, funnel and geography query takes the same filter: filters.properties, filters.withoutProperties (indexed properties the trace has no value of, such as {"withoutProperties":["organization"]}), users, sessions and tasks (task ids from list_tasks: the traces that ran in the task). A metric takes them too, and groups by "task" (RQL: contains(tasks, <task id>) and each(tasks)). The filters of a dashboard (set_filters) and of query_monitoring take properties too, and narrow every widget.',
      `A flow, step_flow, funnel and geography query groups by one value per small chart: groupBy "task", "user", "session" or {"property":"plan"} (indexed), and groupLimit, the values drawn (${GROUP_LIMITS.min} to ${GROUP_LIMITS.max}, ${GROUP_LIMITS.default} by default). Each value is the same query with the value as one more filter (filters.without ["user"], ["session"] or ["task"] keeps the traces without one), the values of the most traces first; the traces without a value are one group. The result is kind grouped: groups (value, traces, result) and leftOut, the values not drawn.`,
      "A number has no dimension. A metric widget is RQL: a table draws any rows, a number one row with one number, a line one time column and numbers, a bar a time or text column and numbers.",
      "An alert takes a metric query without dimensions. It reads what became known in its window: a trace when it ends, a scorer result when it is stored, so a trace longer than the window counts. A count or a sum of nothing is 0, so trace_count below 10 alerts on silence; a rate, an average or a percentile of nothing is no_data.",
      "A geography query reads where each trace came from. get_location_attributes has the span attributes it is read from; change_location_attributes changes them (organization admins).",
      "A layout is x, y, w and h on 12 columns. Overlaps and gaps are closed.",
    ],
  };
}

function jsonSchema(schema: z.ZodType): object {
  return z.toJSONSchema(schema, { io: "input", reused: "ref" });
}
