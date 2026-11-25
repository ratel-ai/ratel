import { z } from "zod";
import { focusedConsoleEnabled } from "@/lib/console/focused-console";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { invalidParams, McpOperationError, notFound } from "@/lib/mcp/errors";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { round } from "@/lib/mcp/serialize";
import { getDb } from "@/lib/platform/db/client";
import type { Organization } from "@/lib/platform/organizations";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { getProjectById } from "@/lib/platform/projects/queries";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import type { AttentionItem } from "@/lib/views/home/attention";
import {
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
  visibleWidgets,
  WIDGET_CATALOG,
} from "@/lib/views/overview-layout/domain/layout";
import type { OverviewLayoutStore } from "@/lib/views/overview-layout/ports/store";
import { projectEntitiesEnabled } from "@/lib/views/project-entities/flag";
import type { Topology } from "@/lib/views/project-entities/topology";

/**
 * The recap Overview over MCP (`focusedConsole`): `get_overview` reads what the person sees on the
 * web, through the page's own loader and layout, and `change_overview_layout` arranges it through
 * the web's own action. With the flag off neither is listed (`operations/index.ts`), and a caller
 * that reaches a project whose organization has it off is refused.
 */

export interface OverviewOperationDeps {
  getProject: typeof getProjectById;
  getOrganization: (projectId: string) => Promise<Organization | null>;
  focusedConsole: (organization: Pick<Organization, "id">) => Promise<boolean>;
  loadOverview: typeof loadFocusedOverview;
  layoutStore: () => OverviewLayoutStore;
  offeredWidgets: (projectId: string) => Promise<OfferedWidgets>;
  restricted: () => Promise<boolean>;
  /** The Agents and MCP servers pages exist, so the map can link to them. */
  entitiesLinked: (organization: Pick<Organization, "id">) => Promise<boolean>;
  now: () => Date;
}

export const defaultOverviewDeps: OverviewOperationDeps = {
  getProject: getProjectById,
  getOrganization: getOrganizationByProjectId,
  focusedConsole: (organization) => focusedConsoleEnabled(organization),
  loadOverview: loadFocusedOverview,
  layoutStore: () => createDrizzleOverviewLayoutStore(getDb()),
  offeredWidgets: async () => WIDGET_CATALOG,
  restricted: isRestrictedBySupportSession,
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
        'Reads the Overview of a project as the signed-in person sees it: the metrics, the agents and MCP servers, the Health score, the rows that need attention and the widget layout. A removed widget has no data. With an API key, the layout is the default. Example: {"range": "30d"}.',
      keywords: ["overview", "recap", "needs attention", "overview layout", "widgets"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        range: z
          .enum(["7d", "30d"])
          .default("7d")
          .describe("The window of the data: 7 days or 30 days."),
      }),
      async execute(ctx, params) {
        const { project, organization } = await requireOverview(deps, ctx.projectId);
        const read = await readOverviewLayout(project.id, layoutDeps(deps, ctx.auth));
        if (!read.ok) throw refused(read.reason);
        const data = await deps.loadOverview({
          project: {
            id: project.id,
            name: project.name,
            slug: project.slug,
            isDemo: project.isDemo,
          },
          organization,
          window: params.range === "30d" ? 30 : 7,
          layout: read.layout,
          now: deps.now(),
        });
        const removed = data.layout.filter((widget) => widget.removed).map(({ id }) => id);
        return {
          data: overviewData(data, ctx.auth.kind === "api-key" || (await deps.restricted())),
          ...(removed.length > 0
            ? {
                hint: `These widgets are removed and have no data: ${removed.join(", ")}. Call change_overview_layout with change "add" to add one again.`,
              }
            : {}),
          ...(ctx.forView
            ? {
                view: {
                  kind: "overview",
                  overview: data,
                  linked: await deps.entitiesLinked(organization),
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
        const { project } = await requireOverview(deps, ctx.projectId);
        const changed = await changeOverviewLayout(
          project.id,
          layoutChange(params),
          layoutDeps(deps, ctx.auth),
        );
        if (!changed.ok) throw refused(changed.reason);
        return {
          data: { layout: layoutView(changed.layout) },
          hint: "The web page shows this layout when the person loads the Overview again.",
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

function overviewData(data: FocusedOverviewData, defaultLayout: boolean) {
  return {
    project: { id: data.project.id, name: data.project.name },
    href: data.window === 7 ? data.root : `${data.root}?range=${data.rangeParam}`,
    range: data.rangeParam,
    lastEventAt: data.lastEventAt?.toISOString() ?? null,
    hasTelemetry: data.hasTelemetry,
    layout: {
      of: defaultLayout ? ("default" as const) : ("person" as const),
      ...layoutView(data.layout),
    },
    metrics: data.metrics && metricsView(data.metrics),
    topology: data.topology && topologyView(data.topology),
    health: data.health && {
      windowDays: data.health.windowDays,
      href: data.health.href,
      ...(data.health.card.kind === "score"
        ? {
            score: data.health.card.score.value,
            stillCalculating: data.health.card.early,
            ...(data.health.card.lowConfidence
              ? { lowConfidence: data.health.card.lowConfidence }
              : {}),
            lostPoints: data.health.card.lost.map(({ level, label, lost }) => ({
              category: level,
              label,
              points: lost,
            })),
          }
        : {
            score: null,
            why: data.health.card.line,
            ...(data.health.card.failed ? { failed: true } : {}),
          }),
    },
    attention: data.attention && {
      rows: data.attention.items.map((item) => attentionRow(item, data.root)),
      moreIssues: data.attention.moreIssues,
      href: data.attention.healthHref,
      ...(data.attention.partial ? { partial: true } : {}),
    },
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
