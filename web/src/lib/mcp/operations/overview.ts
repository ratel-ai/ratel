import { z } from "zod";
import { focusedConsoleEnabled } from "@/lib/console/focused-console";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { invalidParams, McpOperationError, notFound } from "@/lib/mcp/errors";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { round } from "@/lib/mcp/serialize";
import { mcpClientName, UNKNOWN_CLIENT } from "@/lib/mcp/telemetry/session";
import { getDb } from "@/lib/platform/db/client";
import type { Organization } from "@/lib/platform/organizations";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { getProjectById } from "@/lib/platform/projects/queries";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import type { AttentionItem } from "@/lib/views/home/attention";
import {
  type FocusedAttention,
  type FocusedHealth,
  type FocusedOverviewData,
  loadFocusedOverview,
  type MetricsData,
} from "@/lib/views/home/focused-load";
import {
  changeOverviewLayout,
  LAYOUT_REFUSALS,
  type LayoutDeps,
  type LayoutReader,
  type LayoutRefusal,
  readOverviewLayout,
} from "@/lib/views/overview-layout/actions";
import { createDrizzleOverviewLayoutStore } from "@/lib/views/overview-layout/adapters/drizzle-store";
import {
  type OfferedWidgets,
  OVERVIEW_WIDGETS,
  type OverviewLayout,
  type OverviewWidget,
  type OverviewWidgetId,
  onlyWidget,
  visibleWidgets,
  WIDGET_CATALOG,
} from "@/lib/views/overview-layout/domain/layout";
import type { OverviewLayoutStore } from "@/lib/views/overview-layout/ports/store";
import { projectEntitiesEnabled } from "@/lib/views/project-entities/flag";
import type { Topology } from "@/lib/views/project-entities/topology";

/**
 * The recap Overview over MCP (`focusedConsole`): `get_overview` reads what the person sees on the
 * web, through the page's own loader and layout, or one widget of it through the same loader, and
 * `change_overview_layout` arranges it through the web's own action. Both draw the overview view.
 * A later widget needs an entry in `WIDGET_DATA`, and no operation. With the flag off neither is
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
};

export const defaultOverviewDeps: OverviewOperationDeps = {
  getProject: getProjectById,
  getOrganization: getOrganizationByProjectId,
  focusedConsole: (organization) => focusedConsoleEnabled(organization),
  loadOverview: loadFocusedOverview,
  layoutStore: () => createDrizzleOverviewLayoutStore(getDb()),
  widgets: WIDGET_CATALOG,
  offeredWidgets: async () => WIDGET_CATALOG,
  widgetData: WIDGET_DATA,
  restricted: isRestrictedBySupportSession,
  clientName: requestClientName,
  entitiesLinked: (organization) => projectEntitiesEnabled(organization),
  now: () => new Date(),
};

const CHANGES = ["move", "resize", "add", "remove", "reset"] as const;
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
        'Reads the Overview of a project as the signed-in person sees it: the metrics, the agents and MCP servers, the Health score, the rows that need attention and the widget layout. Give widget to read only that widget, also if it is removed from the Overview. Without widget, a removed widget has no data. With an API key, the layout is the default. Example: {"widget": "health", "range": "30d"}.',
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
        range: z
          .enum(["7d", "30d"])
          .default("7d")
          .describe("The window of the data: 7 days or 30 days."),
      }),
      async execute(ctx, params) {
        const { project, organization } = await requireOverview(deps, ctx.projectId);
        const widget =
          params.widget === undefined
            ? null
            : requireWidget(params.widget, await deps.offeredWidgets(project.id));
        const layout = widget
          ? onlyWidget(widget)
          : await wholeLayout(project.id, layoutDeps(deps, ctx.auth));
        const data = await load(deps, { project, organization }, layout, params.range);
        const view = ctx.forView
          ? { view: await overviewView(deps, organization, data, widget) }
          : {};
        if (widget)
          return {
            data: {
              ...pageData(data),
              widget: widget.id,
              [widget.id]: deps.widgetData[widget.id](data),
            },
            ...view,
          };
        const removed = layout.filter((placed) => placed.removed).map(({ id }) => id);
        return {
          data: {
            ...pageData(data),
            layout: {
              of:
                ctx.auth.kind === "api-key" || (await deps.restricted())
                  ? ("default" as const)
                  : ("person" as const),
              ...layoutView(layout),
            },
            ...Object.fromEntries(layout.map(({ id }) => [id, deps.widgetData[id](data)])),
          },
          ...(removed.length > 0
            ? {
                hint: `These widgets are removed and have no data: ${removed.join(", ")}. Call get_overview with widget to read one. Call change_overview_layout with change "add" to add one again.`,
              }
            : {}),
          ...view,
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
        'Changes the Overview layout of the signed-in person in one project. Other people keep their layouts. The grid has 12 columns. Call get_overview first to read the layout. An API key cannot change a layout. Example: {"change": "move", "widget": "attention", "x": 0, "y": 0}.',
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
            "move needs widget, x and y. resize needs widget, w and h. add and remove need widget. reset restores the default layout and needs no other parameter.",
          ),
        widget: z.enum(OVERVIEW_WIDGETS).optional().describe("The widget to change."),
        x: cell(0, 11).describe("The first column of the widget. Column 0 is the left column."),
        y: cell(0, 10_000).describe(
          "The first row of the widget. Row 0 is the top row. The other widgets make room.",
        ),
        w: cell(1, 12).describe("The width in columns. Each widget has a minimum width."),
        h: cell(1, 24).describe("The height in rows. Each widget has a minimum height."),
      }),
      async execute(ctx, params) {
        const { project, organization } = await requireOverview(deps, ctx.projectId);
        const changed = await changeOverviewLayout(
          project.id,
          layoutChange(params),
          layoutDeps(deps, ctx.auth),
          null,
        );
        if (!changed.ok) throw refused(changed.reason);
        const { layout } = changed;
        // The layout is saved: a drawing that fails never makes the change look refused.
        const view = ctx.forView
          ? await loadOrFallback({
              operation: "overview_mcp_changed_view",
              distinctId: `project:${project.id}`,
              fallback: null,
              load: async () =>
                overviewView(
                  deps,
                  organization,
                  await load(deps, { project, organization }, layout, "7d"),
                ),
            })
          : null;
        return {
          data: { layout: layoutView(layout) },
          hint: "The web page shows this layout when the person loads the Overview again.",
          ...(view ? { view } : {}),
        };
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

async function wholeLayout(projectId: string, deps: LayoutDeps): Promise<OverviewLayout> {
  const read = await readOverviewLayout(projectId, deps);
  if (!read.ok) throw refused(read.reason);
  return read.layout;
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
  widget: OverviewWidget | null = null,
) {
  return {
    kind: "overview",
    overview,
    linked: await deps.entitiesLinked(organization),
    ...(widget ? { widget: widget.id } : {}),
  };
}

function refused(reason: LayoutRefusal): McpOperationError {
  if (reason === "not_found") return notFound("project");
  if (reason === "invalid") return invalidParams(LAYOUT_REFUSALS.invalid);
  return new McpOperationError("forbidden", LAYOUT_REFUSALS[reason], { reason });
}

interface ChangeParams {
  change: (typeof CHANGES)[number];
  widget?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

const NEEDS: Record<ChangeParams["change"], readonly Exclude<keyof ChangeParams, "change">[]> = {
  move: ["widget", "x", "y"],
  resize: ["widget", "w", "h"],
  add: ["widget"],
  remove: ["widget"],
  reset: [],
};

function layoutChange(params: ChangeParams): Record<string, unknown> {
  const needs = NEEDS[params.change];
  const missing = needs.filter((name) => params[name] === undefined);
  if (missing.length > 0)
    throw invalidParams(
      `The change "${params.change}" needs these parameters: ${missing.join(", ")}.`,
      missing.map((path) => ({ path, message: "Required for this change." })),
    );
  return {
    kind: params.change,
    ...Object.fromEntries(needs.map((name) => [name, params[name]])),
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

/** The visible widgets in reading order, then the removed ones. */
function layoutView(layout: OverviewLayout) {
  return {
    columns: 12,
    widgets: [
      ...visibleWidgets(layout).map(({ id, x, y, w, h }) => ({
        id,
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
