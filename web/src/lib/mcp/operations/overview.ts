import { z } from "zod";
import { focusedConsoleEnabled } from "@/lib/console/focused-console";
import { GRID_COLUMNS } from "@/lib/console/grid/layout";
import { projectRoot } from "@/lib/console/navigation";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { invalidParams, McpOperationError, notFound } from "@/lib/mcp/errors";
import { cappedResult, headline } from "@/lib/mcp/operations/monitoring/results";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { round, TruncationTracker } from "@/lib/mcp/serialize";
import { mcpClientName, UNKNOWN_CLIENT } from "@/lib/mcp/telemetry/session";
import { getDb } from "@/lib/platform/db/client";
import type { Organization } from "@/lib/platform/organizations";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { getProjectById } from "@/lib/platform/projects/queries";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import type { AttentionItem } from "@/lib/views/home/attention";
import {
  type FocusedAlerts,
  type FocusedAttention,
  type FocusedHealth,
  type FocusedOverviewData,
  loadFocusedOverview,
  type MetricsData,
} from "@/lib/views/home/focused-load";
import {
  changeOverviewLayout,
  LAYOUT_REFUSALS,
  type LayoutChangeResult,
  type LayoutDeps,
  type LayoutHistoryEntry,
  type LayoutReader,
  type LayoutRefused,
  type LayoutSnapshot,
  readOverviewHistory,
  readOverviewLayout,
  restoreOverviewLayout,
  undoOverviewChange,
} from "@/lib/views/overview-layout/actions";
import { createDrizzleOverviewLayoutStore } from "@/lib/views/overview-layout/adapters/drizzle-store";
import { findDashboardWidget } from "@/lib/views/overview-layout/dashboard-widgets";
import {
  dashboardItemId,
  isDashboardItem,
  type OfferedWidgets,
  OVERVIEW_WIDGETS,
  type OverviewItemId,
  type OverviewLayout,
  type OverviewPlacement,
  type OverviewWidget,
  type OverviewWidgetId,
  onlyWidget,
  parseDashboardItem,
  placementTitle,
  visibleWidgets,
  WIDGET_CATALOG,
} from "@/lib/views/overview-layout/domain/layout";
import type { OverviewLayoutStore } from "@/lib/views/overview-layout/ports/store";
import { projectEntitiesEnabled } from "@/lib/views/project-entities/flag";
import type { Topology } from "@/lib/views/project-entities/topology";

/**
 * The recap Overview over MCP (`focusedConsole`): `get_overview` reads what the person sees on the
 * web, through the page's own loader and layout, or one widget of it through the same loader, and
 * `change_overview_layout` arranges it through the web's own action. `list_overview_changes`,
 * `undo_overview_change` and `restore_overview_layout` are the web's History, Undo and Restore. All
 * draw the overview view.
 * A later widget needs an entry in `WIDGET_DATA`, and no operation. With the flag off none is
 * listed (`operations/index.ts`), and a caller that reaches a project whose organization has it off
 * is refused.
 */

export interface OverviewOperationDeps {
  getProject: typeof getProjectById;
  getOrganization: (projectId: string) => Promise<Organization | null>;
  focusedConsole: (organization: Pick<Organization, "id">) => Promise<boolean>;
  loadOverview: typeof loadFocusedOverview;
  layoutStore: () => OverviewLayoutStore;
  /** Every widget there is, which the parameter lists. A project may be offered fewer. */
  widgets: OfferedWidgets;
  offeredWidgets: (projectId: string) => Promise<OfferedWidgets>;
  /** A widget of a dashboard of the project, which can be on the Overview. */
  dashboardWidget: LayoutDeps["dashboardWidget"];
  /** What an agent reads of each widget. */
  widgetData: Readonly<Record<OverviewWidgetId, WidgetData>>;
  restricted: () => Promise<boolean>;
  /** The MCP client's name, as it gave it; null when it gave none. */
  clientName: () => Promise<string | null>;
  /** The Agents and MCP servers pages exist, so the map can link to them. */
  entitiesLinked: (organization: Pick<Organization, "id">) => Promise<boolean>;
  now: () => Date;
}

type WidgetData = (data: FocusedOverviewData) => unknown;

/** What an agent reads of each widget: the same numbers as the page. Null when it is removed. */
export const WIDGET_DATA: Readonly<Record<OverviewWidgetId, WidgetData>> = {
  metrics: ({ metrics }) => metrics && metricsView(metrics),
  topology: ({ topology }) => topology && topologyView(topology),
  health: ({ health }) => health && healthView(health),
  attention: ({ attention, root }) => attention && attentionView(attention, root),
  alerts: ({ alerts }) => alerts && alertsView(alerts),
};

export const defaultOverviewDeps: OverviewOperationDeps = {
  getProject: getProjectById,
  getOrganization: getOrganizationByProjectId,
  focusedConsole: (organization) => focusedConsoleEnabled(organization),
  loadOverview: loadFocusedOverview,
  layoutStore: () => createDrizzleOverviewLayoutStore(getDb()),
  widgets: WIDGET_CATALOG,
  offeredWidgets: async () => WIDGET_CATALOG,
  dashboardWidget: (projectId, ref) => findDashboardWidget(projectId, ref),
  widgetData: WIDGET_DATA,
  restricted: isRestrictedBySupportSession,
  clientName: requestClientName,
  entitiesLinked: (organization) => projectEntitiesEnabled(organization),
  now: () => new Date(),
};

const CHANGES = ["move", "resize", "add", "remove", "reset"] as const;
const REVISION = z
  .string()
  .describe(
    "The revision of the layout that you read. If the layout changed after that, the call changes nothing.",
  );
const DASHBOARD_ID = z.string().max(100);
const WIDGET_ID = z.string().max(100);
const cell = (low: number, high: number) => z.number().int().min(low).max(high).optional();

export function overviewOperations(
  deps: OverviewOperationDeps = defaultOverviewDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "get_overview",
      domain: "observability",
      title: "Get the Overview",
      description:
        'Reads the Overview of a project as the signed-in person sees it: its widgets with their data, the dashboard widgets on it and the layout. Give widget, or dashboardId and widgetId, to read only that widget, also if it is removed. Without them, a removed widget has no data. With an API key, the layout is the default. Example: {"widget": "health", "range": "30d"}.',
      keywords: [
        "overview",
        "recap",
        "needs attention",
        "overview layout",
        "widgets",
        "one widget",
      ],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        // A string, so that an unknown name gets the refusal below, which lists the project's widgets.
        widget: z
          .string()
          .optional()
          .meta({ enum: deps.widgets.map(({ id }) => id) })
          .describe("The widget to read. Without it, the result is the whole Overview."),
        dashboardId: DASHBOARD_ID.optional().describe(
          "With widgetId: reads only that dashboard widget, also if it is not on the Overview. list_dashboards gives the IDs.",
        ),
        widgetId: WIDGET_ID.optional().describe("With dashboardId. get_dashboard gives the IDs."),
        range: z
          .enum(["7d", "30d"])
          .default("7d")
          .describe("The window of the data: 7 days or 30 days."),
      }),
      async execute(ctx, params) {
        const { project, organization } = await requireOverview(deps, ctx.projectId);
        const alone = await onlyLayout(deps, project.id, params);
        const saved = alone
          ? { layout: alone, revision: "", undo: null }
          : await savedLayout(project.id, layoutDeps(deps, ctx.auth));
        const { layout } = saved;
        const data = await load(deps, { project, organization }, layout, params.range);
        const view = ctx.forView
          ? { view: await overviewView(deps, organization, data, alone?.[0].id) }
          : {};
        const tracker = new TruncationTracker();
        if (alone) {
          const [{ id }] = alone;
          return {
            data: {
              ...pageData(data),
              widget: id,
              ...(isDashboardItem(id)
                ? { dashboardWidgets: dashboardWidgetsView(data, tracker) }
                : { [id]: deps.widgetData[id](data) }),
            },
            truncated: tracker.value,
            ...view,
          };
        }
        const removed = layout.filter((placed) => placed.removed).map(({ id }) => id);
        return {
          data: {
            ...pageData(data),
            layout: {
              of:
                ctx.auth.kind === "api-key" || (await deps.restricted())
                  ? ("default" as const)
                  : ("person" as const),
              ...snapshotView(saved),
            },
            ...Object.fromEntries(
              layout.flatMap(({ id }) =>
                isDashboardItem(id) ? [] : [[id, deps.widgetData[id](data)]],
              ),
            ),
            dashboardWidgets: dashboardWidgetsView(data, tracker),
          },
          truncated: tracker.value,
          ...(removed.length > 0
            ? {
                hint: `These widgets are removed and have no data: ${removed.join(", ")}. Call get_overview with widget to read one. Call change_overview_layout with change "add" to add one again.`,
              }
            : {}),
          ...view,
        };
      },
    }),
    defineOperation({
      id: "list_overview_changes",
      domain: "observability",
      title: "List the changes of the Overview layout",
      description:
        "Lists the last 25 changes of the signed-in person's Overview layout in one project, newest first. Each change has an ID, its time, where the person made it (web or an MCP client), what changed and the layout after it. The result has the revision that undo_overview_change and restore_overview_layout need. A person reads only their own changes. An API key has no changes.",
      keywords: ["overview history", "layout history", "undo", "restore layout", "who changed"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        const { project } = await requireOverview(deps, ctx.projectId);
        const history = await readOverviewHistory(project.id, layoutDeps(deps, ctx.auth));
        if (!history.ok) throw refused(history);
        const { entries, snapshot } = history;
        return {
          data: {
            project: { id: project.id, name: project.name },
            href: projectRoot(project.id),
            layout: snapshotView(snapshot),
            changes: entries.map(changeView),
          },
          ...(ctx.forView
            ? {
                view: {
                  kind: "overview-history",
                  project: { id: project.id, name: project.name },
                  root: projectRoot(project.id),
                  now: deps.now().toISOString(),
                  entries: entries.map(({ id, source, summary, current, readable, at }) => ({
                    id,
                    source,
                    summary,
                    current,
                    readable,
                    at: at.toISOString(),
                  })),
                },
              }
            : {}),
        };
      },
    }),
  ];
}

export function overviewWriteOperations(
  deps: OverviewOperationDeps = defaultOverviewDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "change_overview_layout",
      domain: "writes",
      title: "Change the Overview layout",
      description:
        'Changes the Overview layout of the signed-in person in one project. Other people keep their layouts. The grid has 12 columns. The widget is one of the Overview, or a dashboard widget: give dashboardId and widgetId. Call get_overview first to read the layout. An API key cannot change a layout. Example: {"change": "move", "widget": "attention", "x": 0, "y": 0}.',
      keywords: [
        "arrange overview",
        "move widget",
        "resize widget",
        "add widget",
        "remove widget",
        "reset layout",
      ],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        change: z
          .enum(CHANGES)
          .describe(
            "move needs a widget, x and y. resize needs a widget, w and h. add and remove need a widget. reset restores the default layout and needs no other parameter.",
          ),
        widget: z.enum(OVERVIEW_WIDGETS).optional().describe("The widget to change."),
        dashboardId: DASHBOARD_ID.optional().describe(
          "With widgetId, in place of widget: a dashboard widget. The Overview shows it as its dashboard has it now. add puts it at the bottom. list_dashboards gives the IDs.",
        ),
        widgetId: WIDGET_ID.optional().describe("With dashboardId. get_dashboard gives the IDs."),
        x: cell(0, 11).describe("The first column of the widget. Column 0 is the left column."),
        y: cell(0, 10_000).describe(
          "The first row of the widget. Row 0 is the top row. The other widgets make room.",
        ),
        w: cell(1, 12).describe("The width in columns. Each widget has a minimum width."),
        h: cell(1, 24).describe("The height in rows. Each widget has a minimum height."),
        revision: z
          .string()
          .optional()
          .describe(
            "The revision of the layout that you read. If the layout changed after that, the call changes nothing. Without it, the change applies to the latest layout.",
          ),
      }),
      async execute(ctx, params) {
        const overview = await requireOverview(deps, ctx.projectId);
        const changed = await changeOverviewLayout(
          overview.project.id,
          layoutChange(params),
          layoutDeps(deps, ctx.auth),
          params.revision ?? null,
        );
        return changedResult(deps, overview, changed, ctx.forView);
      },
    }),
    defineOperation({
      id: "undo_overview_change",
      domain: "writes",
      title: "Undo the latest change of the Overview layout",
      description:
        "Takes back the latest change of the signed-in person's Overview layout in one project that is not taken back yet. Call it again to go further back. The undo is a new change in the history, so nothing is lost. Call list_overview_changes or get_overview first to read the revision. An API key cannot undo.",
      keywords: ["undo layout", "take back", "revert overview"],
      scope: "project",
      mutates: true,
      params: z.object({ ...projectScoped, revision: REVISION }),
      async execute(ctx, params) {
        const overview = await requireOverview(deps, ctx.projectId);
        const changed = await undoOverviewChange(
          overview.project.id,
          layoutDeps(deps, ctx.auth),
          params.revision,
        );
        return changedResult(deps, overview, changed, ctx.forView);
      },
    }),
    defineOperation({
      id: "restore_overview_layout",
      domain: "writes",
      title: "Restore an earlier Overview layout",
      description:
        "Restores the signed-in person's Overview layout in one project to the layout after one change in the history. The restore is a new change in the history, so nothing is lost. Call list_overview_changes first to read the change ID and the revision. An API key cannot restore.",
      keywords: ["restore layout", "go back", "earlier layout", "revert overview"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        changeId: z
          .number()
          .int()
          .min(1)
          .describe("The ID of the change, from list_overview_changes."),
        revision: REVISION,
      }),
      async execute(ctx, params) {
        const overview = await requireOverview(deps, ctx.projectId);
        const changed = await restoreOverviewLayout(
          overview.project.id,
          params.changeId,
          layoutDeps(deps, ctx.auth),
          params.revision,
        );
        return changedResult(deps, overview, changed, ctx.forView);
      },
    }),
  ];
}

/** The MCP side of `LayoutReader`: dispatch has already authorized the project. */
export function mcpLayoutReader(
  auth: McpAuthContext,
  restricted: () => Promise<boolean>,
): LayoutDeps["reader"] {
  return async (projectId): Promise<LayoutReader> =>
    auth.kind === "api-key"
      ? { kind: "api-key" }
      : {
          kind: "person",
          projectId,
          personId: auth.externalUserId,
          restricted: await restricted(),
        };
}

/** `focusedConsole` for the connection: an API key's organization, or any of a person's. */
export async function focusedConsoleForCaller(
  auth: McpAuthContext,
  focused: (organization: Pick<Organization, "id">) => Promise<boolean> = (organization) =>
    focusedConsoleEnabled(organization),
): Promise<boolean> {
  const ids =
    auth.kind === "api-key"
      ? auth.organization
        ? [auth.organization.id]
        : []
      : auth.memberships.map(({ organizationId }) => organizationId);
  return (await Promise.all(ids.map((id) => focused({ id })))).some(Boolean);
}

// — Helpers ——————————————————————————————————————————————————————————————————

function layoutDeps(deps: OverviewOperationDeps, auth: McpAuthContext): LayoutDeps {
  return {
    reader: mcpLayoutReader(auth, deps.restricted),
    store: deps.layoutStore,
    offered: deps.offeredWidgets,
    dashboardWidget: deps.dashboardWidget,
    source: async () => ({ kind: "mcp", client: await deps.clientName() }),
  };
}

async function requireOverview(deps: OverviewOperationDeps, projectId: string) {
  const [project, organization] = await Promise.all([
    deps.getProject(projectId),
    deps.getOrganization(projectId),
  ]);
  if (!project || !organization) throw notFound("project");
  if (!(await deps.focusedConsole(organization))) {
    throw new McpOperationError("forbidden", "The Overview is not available for this project.", {
      reason: "focused_console_off",
    });
  }
  return { project, organization };
}

function requireWidget(id: string, offered: OfferedWidgets): OverviewWidget {
  const widget = offered.find((candidate) => candidate.id === id);
  if (widget) return widget;
  const message = `The Overview has no widget with the name "${id.slice(0, 40)}". The widgets are: ${offered.map((one) => one.id).join(", ")}.`;
  throw invalidParams(message, [{ path: "widget", message: "Not a widget of this project." }]);
}

async function savedLayout(projectId: string, deps: LayoutDeps): Promise<LayoutSnapshot> {
  const read = await readOverviewLayout(projectId, deps);
  if (!read.ok) throw refused(read);
  return read;
}

const MAX_CLIENT_NAME = 60;

/** From the request's User-Agent: the server is stateless and sees no client name. */
async function requestClientName(): Promise<string | null> {
  const { headers } = await import("next/headers");
  const name = mcpClientName(await headers());
  return name === UNKNOWN_CLIENT ? null : name.slice(0, MAX_CLIENT_NAME);
}

/** The page's own loader: it reads only what the visible widgets of the layout need. */
function load(
  deps: OverviewOperationDeps,
  { project, organization }: Awaited<ReturnType<typeof requireOverview>>,
  layout: OverviewLayout,
  range: "7d" | "30d",
): Promise<FocusedOverviewData> {
  return deps.loadOverview({
    project: { id: project.id, name: project.name, slug: project.slug, isDemo: project.isDemo },
    organization,
    window: range === "30d" ? 30 : 7,
    layout,
    now: deps.now(),
  });
}

/** What the overview view draws (mcp-apps/views/overview). `widget`: that one alone. */
async function overviewView(
  deps: OverviewOperationDeps,
  organization: Pick<Organization, "id">,
  overview: FocusedOverviewData,
  /** The entry that was asked for alone. */
  widget: OverviewItemId | null = null,
) {
  return {
    kind: "overview",
    overview,
    linked: await deps.entitiesLinked(organization),
    ...(widget ? { widget } : {}),
  };
}

/** The layout of the one widget that was asked for; null for the whole Overview. */
async function onlyLayout(
  deps: OverviewOperationDeps,
  projectId: string,
  params: WidgetParams,
): Promise<OverviewLayout | null> {
  const id = widgetOf(params);
  if (id === undefined) return null;
  if (!isDashboardItem(id))
    return onlyWidget(requireWidget(id, await deps.offeredWidgets(projectId)));
  const ref = parseDashboardItem(id);
  const source = ref && (await deps.dashboardWidget(projectId, ref));
  if (!source) throw refused({ ok: false, reason: "no_source" });
  const { title, h } = source;
  return [{ id, x: 0, y: 0, w: GRID_COLUMNS, h, removed: false, title }];
}

interface WidgetParams {
  widget?: string;
  dashboardId?: string;
  widgetId?: string;
}

/** One of the Overview's own by name, or a dashboard widget by its two IDs. */
function widgetOf({ widget, dashboardId, widgetId }: WidgetParams): string | undefined {
  if (dashboardId === undefined && widgetId === undefined) return widget;
  if (dashboardId === undefined || widgetId === undefined || widget !== undefined)
    throw invalidParams("A dashboard widget needs dashboardId and widgetId, and no widget.", [
      {
        path:
          dashboardId === undefined
            ? "dashboardId"
            : widgetId === undefined
              ? "widgetId"
              : "widget",
        message: "Give dashboardId and widgetId together, without widget.",
      },
    ]);
  return dashboardItemId(dashboardId, widgetId);
}

function refused({ reason }: LayoutRefused): McpOperationError {
  if (reason === "not_found") return notFound("project");
  if (reason === "invalid") return invalidParams(LAYOUT_REFUSALS.invalid);
  if (reason === "no_source")
    return invalidParams(
      `${LAYOUT_REFUSALS.no_source} list_dashboards and get_dashboard give the IDs.`,
      [{ path: "widgetId", message: "Not a widget of that dashboard." }],
    );
  if (reason === "not_kept")
    return invalidParams(LAYOUT_REFUSALS.not_kept, [
      { path: "changeId", message: "Not a change in the history." },
    ]);
  if (reason === "stale")
    return new McpOperationError(
      "conflict",
      `${LAYOUT_REFUSALS.stale} Call list_overview_changes to read the latest changes and the revision.`,
      { reason },
    );
  const code = reason === "nothing_to_undo" || reason === "too_many" ? "conflict" : "forbidden";
  return new McpOperationError(code, LAYOUT_REFUSALS[reason], { reason });
}

/** What a change, an undo and a restore answer. */
async function changedResult(
  deps: OverviewOperationDeps,
  overview: Awaited<ReturnType<typeof requireOverview>>,
  changed: LayoutChangeResult,
  forView: boolean | undefined,
) {
  if (!changed.ok) throw refused(changed);
  // The layout is saved: a drawing that fails never makes the change look refused.
  const view = forView
    ? await loadOrFallback({
        operation: "overview_mcp_changed_view",
        distinctId: `project:${overview.project.id}`,
        fallback: null,
        load: async () =>
          overviewView(
            deps,
            overview.organization,
            await load(deps, overview, changed.layout, "7d"),
          ),
      })
    : null;
  return {
    data: { changed: changed.changed, layout: snapshotView(changed) },
    hint: changed.changed
      ? "The web page shows this layout when the person loads the Overview again."
      : "The layout was that one already. Nothing changed.",
    ...(view ? { view } : {}),
  };
}

interface ChangeParams extends WidgetParams {
  change: (typeof CHANGES)[number];
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

const NEEDS: Record<ChangeParams["change"], readonly ("widget" | "x" | "y" | "w" | "h")[]> = {
  move: ["widget", "x", "y"],
  resize: ["widget", "w", "h"],
  add: ["widget"],
  remove: ["widget"],
  reset: [],
};

function layoutChange(params: ChangeParams): Record<string, unknown> {
  const needs = NEEDS[params.change];
  const given = { ...params, widget: widgetOf(params) };
  const missing = needs.filter((name) => given[name] === undefined);
  if (missing.length > 0)
    throw invalidParams(
      `The change "${params.change}" needs these parameters: ${missing.join(", ")}.`,
      missing.map((path) => ({ path, message: "Required for this change." })),
    );
  return {
    kind: params.change,
    ...Object.fromEntries(needs.map((name) => [name, given[name]])),
  };
}

function pageData(data: FocusedOverviewData) {
  return {
    project: { id: data.project.id, name: data.project.name },
    href: data.window === 7 ? data.root : `${data.root}?range=${data.rangeParam}`,
    range: data.rangeParam,
    lastEventAt: data.lastEventAt?.toISOString() ?? null,
    hasTelemetry: data.hasTelemetry,
  };
}

function snapshotView({ layout, revision, undo }: LayoutSnapshot) {
  return { ...layoutView(layout), revision, undoTakesBack: undo };
}

function changeView(entry: LayoutHistoryEntry) {
  const { id, kind, personId, source, at, summary, layout, current } = entry;
  return {
    id,
    kind,
    what: summary,
    at: at.toISOString(),
    author: { personId },
    source: source.kind,
    ...(source.kind === "mcp" ? { client: source.client } : {}),
    current,
    layout: layout && layoutView(layout),
  };
}

/** The visible widgets in reading order, then the removed ones. */
function layoutView(layout: OverviewLayout) {
  return {
    columns: 12,
    widgets: [
      ...visibleWidgets(layout).map(({ x, y, w, h, ...entry }) => ({
        id: entry.id,
        ...itemNames(entry),
        removed: false,
        x,
        y,
        w,
        h,
      })),
      ...layout.filter(({ removed }) => removed).map(({ id }) => ({ id, removed: true })),
    ],
  };
}

/** What names a dashboard widget in a call. */
function itemNames(entry: Pick<OverviewPlacement, "id" | "title">) {
  if (!isDashboardItem(entry.id)) return {};
  return { ...parseDashboardItem(entry.id), name: placementTitle(entry) };
}

const ITEM_ROWS = 20;

/** The numbers as query_monitoring gives them, or why there are none. */
function dashboardWidgetsView(data: FocusedOverviewData, tracker: TruncationTracker) {
  const { dashboards, layout } = data;
  return visibleWidgets(layout).flatMap((entry): object[] => {
    if (!isDashboardItem(entry.id)) return [];
    const names = { id: entry.id, ...itemNames(entry) };
    if (dashboards === "failed") return [{ ...names, failed: true }];
    const item = dashboards?.[entry.id];
    if (!item) return [];
    if (item.kind === "broken")
      return [{ ...names, ...(item.title ? { name: item.title } : {}), problem: item.problem }];
    const { title, dashboard, widget, result, filters } = item;
    return [
      {
        ...names,
        name: title,
        dashboard: dashboard.name,
        href: dashboard.href,
        chart: widget.chart,
        filters,
        summary: headline(widget.query, result),
        result: result && cappedResult(widget.query, result, ITEM_ROWS, tracker),
      },
    ];
  });
}

function metricsView(metrics: MetricsData | "failed") {
  if (metrics === "failed") return { failed: true };
  const numbers = ({
    count,
    errorCount,
    errorRate,
    p50DurationMs,
    costUsd,
  }: typeof metrics.traces) => ({
    runs: count,
    failedRuns: errorCount,
    failedShare: round(errorRate),
    medianDurationMs: p50DurationMs === null ? null : round(p50DurationMs, 2),
    spendUsd: costUsd,
  });
  return {
    ...numbers(metrics.traces),
    previous: metrics.previous ? numbers(metrics.previous) : null,
    sdk: metrics.sdk ? { current: metrics.sdk.current, previous: metrics.sdk.previous } : null,
    href: `${metrics.root}/traces?range=${metrics.rangeParam}`,
  };
}

function topologyView(topology: Topology | "failed") {
  if (topology === "failed") return { failed: true };
  return {
    nodes: topology.nodes.map(({ id, kind, name, count, errorRate, failing }) => ({
      id,
      kind,
      name,
      count,
      errorRate: round(errorRate),
      failing,
    })),
    edges: topology.edges,
    leftOut: topology.omitted,
  };
}

function healthView({ windowDays, href, card }: FocusedHealth) {
  return {
    windowDays,
    href,
    ...(card.kind === "score"
      ? {
          score: card.score.value,
          stillCalculating: card.early,
          ...(card.lowConfidence ? { lowConfidence: card.lowConfidence } : {}),
          lostPoints: card.lost.map(({ level, label, lost }) => ({
            category: level,
            label,
            points: lost,
          })),
        }
      : { score: null, why: card.line, ...(card.failed ? { failed: true } : {}) }),
  };
}

function attentionView(attention: FocusedAttention, root: string) {
  return {
    rows: attention.items.map((item) => attentionRow(item, root)),
    moreIssues: attention.moreIssues,
    href: attention.healthHref,
    ...(attention.partial ? { partial: true } : {}),
  };
}

function alertsView(alerts: FocusedAlerts | "failed") {
  if (alerts === "failed") return { failed: true };
  return { count: alerts.items.length, rows: alerts.items, href: alerts.href };
}

function attentionRow(item: AttentionItem, root: string) {
  const { subject } = item;
  return {
    key: item.key,
    urgency: item.tone,
    about: item.mark,
    title: item.title,
    subject:
      subject === null
        ? null
        : subject.kind === "tools"
          ? { tools: subject.tools.map(({ name }) => name), more: subject.more }
          : { [subject.kind]: subject.name },
    figure: `${item.figure.value} ${item.figure.caption}`,
    href: item.target.kind === "link" ? item.target.href : `${root}?peek=${item.target.peek}`,
  };
}
