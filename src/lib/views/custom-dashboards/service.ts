import { listPivots } from "@/lib/ingest/pivots/store";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import {
  canAddWidget,
  canEditDashboard,
  canOpenDashboard,
  canShareDashboard,
  DASHBOARD_SHARING,
  type Dashboard,
  type DashboardSharing,
  type DashboardWidget,
  moveWidget,
  validateDashboardName,
} from "./model";
import { validateWidgetSpec, type WidgetSpecError } from "./spec";
import {
  type DashboardsDb,
  deleteDashboard,
  deleteWidget,
  findDashboard,
  insertDashboard,
  insertWidget,
  listOpenDashboards,
  listWidgets,
  setWidgetOrder,
  updateDashboardName,
  updateDashboardSharing,
  updateWidgetSpec,
} from "./store";

/**
 * Custom dashboards (RC-888): a project member lists, creates, renames and
 * deletes dashboards, and adds, edits, moves and removes their widgets, with
 * `cloud-custom-dashboards` on. Each call checks project membership, then the
 * rule of `./model`: a dashboard the person may not open reads not-found.
 */

export type DashboardEvent =
  | "dashboard_created"
  | "dashboard_deleted"
  | "dashboard_widget_added"
  | "dashboard_shared";

export interface DashboardsDeps {
  db?: DashboardsDb;
  /** The signed-in person, or null. */
  getActor: () => Promise<{ userId: string; externalId: string } | null>;
  /** The project's organization id when the person is a member of the project, else null. */
  findScope: (projectId: string, userId: string) => Promise<{ organizationId: string } | null>;
  isEnabled: () => Promise<boolean>;
  /** An admin support session may look but not change dashboards. */
  isRestricted?: () => Promise<boolean>;
  track?: (
    event: DashboardEvent,
    context: { externalId: string; projectId: string; orgId: string },
    properties: Record<string, unknown>,
  ) => Promise<void>;
}

export const DASHBOARD_ERRORS = {
  signed_out: "Sign in to use dashboards.",
  not_found: "That dashboard does not exist, or it is not shared with you.",
  restricted: "A support session cannot change dashboards.",
  invalid_name: "Enter a name of 1 to 80 characters.",
  invalid_sharing: "Choose private or project.",
  not_creator: "Only the creator of a dashboard changes who sees it.",
  missing_widget: "That widget is gone. Reload the page.",
  limit: "A dashboard has at most 20 widgets. Remove one first.",
  invalid_spec: "That widget is not valid.",
  unknown_metric: "Choose a metric from the list.",
  unknown_group_by: "Choose a group-by from the list.",
  unknown_chart: "Choose a chart from the list.",
  invalid_filter: "That filter is not valid.",
  invalid_range: "Choose a range from the list.",
  range_over_retention: "A widget reads at most the last 30 days.",
  invalid_top_n: "Show from 1 to 50 groups.",
  chart_group_by_mismatch:
    "That chart cannot draw that group-by. A KPI has none, a line groups by day.",
  unconfigured_pivot: "That pivot is not set up for this project.",
} as const satisfies Record<string, string> & Record<WidgetSpecError, string>;

export type DashboardErrorCode = keyof typeof DASHBOARD_ERRORS;
export type Refusal = { ok: false; code: DashboardErrorCode; error: string };
export type DashboardResult<T> = ({ ok: true } & T) | Refusal;

interface Actor {
  externalId: string;
  orgId: string;
}

const logger = getLogger("custom-dashboards");

/** The dashboards the member opens in the project. */
export async function readDashboards(
  projectId: string,
  deps: DashboardsDeps,
): Promise<DashboardResult<{ dashboards: Dashboard[] }>> {
  const actor = await authorize(projectId, deps, { write: false });
  if ("code" in actor) return actor;
  return { ok: true, dashboards: await listOpenDashboards(projectId, actor.externalId, db(deps)) };
}

/** One dashboard and its widgets, when the member may open it. */
export async function readDashboard(
  projectId: string,
  dashboardId: string,
  deps: DashboardsDeps,
): Promise<
  DashboardResult<{
    dashboard: Dashboard;
    widgets: DashboardWidget[];
    canEdit: boolean;
    canShare: boolean;
  }>
> {
  const opened = await openDashboard(projectId, dashboardId, deps, { write: false });
  if (!opened.ok) return opened;
  return {
    ok: true,
    dashboard: opened.dashboard,
    widgets: await listWidgets(dashboardId, db(deps)),
    canEdit: canEditDashboard(opened.dashboard, opened.actor.externalId),
    canShare: canShareDashboard(opened.dashboard, opened.actor.externalId),
  };
}

/** Create a private dashboard owned by the member. */
export async function createDashboard(
  projectId: string,
  name: unknown,
  deps: DashboardsDeps,
): Promise<DashboardResult<{ dashboard: Dashboard }>> {
  const actor = await authorize(projectId, deps);
  if ("code" in actor) return actor;
  const checked = validateDashboardName(name);
  if (!checked.ok) return refuse("invalid_name", projectId);
  const dashboard = await insertDashboard(projectId, checked.value, actor.externalId, db(deps));
  await track(deps, "dashboard_created", actor, projectId, { dashboard_id: dashboard.id });
  return { ok: true, dashboard };
}

export async function renameDashboard(
  projectId: string,
  dashboardId: string,
  name: unknown,
  deps: DashboardsDeps,
): Promise<DashboardResult<object>> {
  const opened = await openDashboard(projectId, dashboardId, deps, { write: true });
  if (!opened.ok) return opened;
  const checked = validateDashboardName(name);
  if (!checked.ok) return refuse("invalid_name", projectId);
  if (!(await updateDashboardName(projectId, dashboardId, checked.value, db(deps))))
    return refuse("not_found", projectId);
  return { ok: true };
}

/**
 * Set who opens the dashboard (RC-889): its creator only, or every project
 * member by link. Only the creator shares or unshares (`canShareDashboard`).
 * Another member who opens a project dashboard gets `not_creator`; one who may
 * not open it gets not-found, as for every other call.
 */
export async function shareDashboard(
  projectId: string,
  dashboardId: string,
  sharing: unknown,
  deps: DashboardsDeps,
): Promise<DashboardResult<object>> {
  const opened = await openDashboard(projectId, dashboardId, deps, { write: true });
  if (!opened.ok) return opened;
  if (!canShareDashboard(opened.dashboard, opened.actor.externalId))
    return refuse("not_creator", projectId);
  if (!DASHBOARD_SHARING.includes(sharing as DashboardSharing))
    return refuse("invalid_sharing", projectId);
  const value = sharing as DashboardSharing;
  if (!(await updateDashboardSharing(projectId, dashboardId, value, db(deps))))
    return refuse("not_found", projectId);
  await track(deps, "dashboard_shared", opened.actor, projectId, {
    dashboard_id: dashboardId,
    sharing: value,
  });
  return { ok: true };
}

export async function removeDashboard(
  projectId: string,
  dashboardId: string,
  deps: DashboardsDeps,
): Promise<DashboardResult<object>> {
  const opened = await openDashboard(projectId, dashboardId, deps, { write: true });
  if (!opened.ok) return opened;
  if (!(await deleteDashboard(projectId, dashboardId, db(deps))))
    return refuse("not_found", projectId);
  await track(deps, "dashboard_deleted", opened.actor, projectId, { dashboard_id: dashboardId });
  return { ok: true };
}

/** Add a widget as the last one, after checking its spec against the whitelist and the project's pivots. */
export async function addWidget(
  projectId: string,
  dashboardId: string,
  spec: unknown,
  deps: DashboardsDeps,
): Promise<DashboardResult<{ widgetId: string }>> {
  const opened = await openDashboard(projectId, dashboardId, deps, { write: true });
  if (!opened.ok) return opened;
  const checked = validateWidgetSpec(spec, { pivots: await listPivots(projectId, db(deps)) });
  if (!checked.ok) return refuse(checked.error, projectId);
  if (!canAddWidget((await listWidgets(dashboardId, db(deps))).length))
    return refuse("limit", projectId);
  const inserted = await insertWidget(projectId, dashboardId, checked.spec, db(deps));
  if (inserted.outcome !== "inserted")
    return refuse(inserted.outcome === "limit" ? "limit" : "not_found", projectId);
  await track(deps, "dashboard_widget_added", opened.actor, projectId, {
    dashboard_id: dashboardId,
    metric: checked.spec.metric,
    group_by: checked.spec.groupBy?.startsWith("pivot:")
      ? "pivot"
      : (checked.spec.groupBy ?? "none"),
    chart: checked.spec.chart,
  });
  return { ok: true, widgetId: inserted.id };
}

export async function updateWidget(
  projectId: string,
  dashboardId: string,
  widgetId: string,
  spec: unknown,
  deps: DashboardsDeps,
): Promise<DashboardResult<object>> {
  const opened = await openDashboard(projectId, dashboardId, deps, { write: true });
  if (!opened.ok) return opened;
  const checked = validateWidgetSpec(spec, { pivots: await listPivots(projectId, db(deps)) });
  if (!checked.ok) return refuse(checked.error, projectId);
  if (!(await updateWidgetSpec(dashboardId, widgetId, checked.spec, db(deps))))
    return refuse("missing_widget", projectId);
  return { ok: true };
}

/** Move one widget up or down by one place. */
export async function reorderWidget(
  projectId: string,
  dashboardId: string,
  widgetId: string,
  direction: "up" | "down",
  deps: DashboardsDeps,
): Promise<DashboardResult<object>> {
  const opened = await openDashboard(projectId, dashboardId, deps, { write: true });
  if (!opened.ok) return opened;
  const order = moveWidget(await listWidgets(dashboardId, db(deps)), widgetId, direction);
  if (!order || !(await setWidgetOrder(dashboardId, order, db(deps))))
    return refuse("missing_widget", projectId);
  return { ok: true };
}

export async function removeWidget(
  projectId: string,
  dashboardId: string,
  widgetId: string,
  deps: DashboardsDeps,
): Promise<DashboardResult<object>> {
  const opened = await openDashboard(projectId, dashboardId, deps, { write: true });
  if (!opened.ok) return opened;
  if (!(await deleteWidget(dashboardId, widgetId, db(deps))))
    return refuse("missing_widget", projectId);
  return { ok: true };
}

/** The dashboard, when the member may open it (and, for a write, edit it). Otherwise not-found. */
async function openDashboard(
  projectId: string,
  dashboardId: string,
  deps: DashboardsDeps,
  options: { write: boolean },
): Promise<{ ok: true; actor: Actor; dashboard: Dashboard } | Refusal> {
  const actor = await authorize(projectId, deps, options);
  if ("code" in actor) return actor;
  const dashboard = await findDashboard(projectId, dashboardId, db(deps));
  if (!dashboard || !canOpenDashboard(dashboard, actor.externalId))
    return refuse("not_found", projectId);
  if (options.write && !canEditDashboard(dashboard, actor.externalId))
    return refuse("not_found", projectId);
  return { ok: true, actor, dashboard };
}

async function authorize(
  projectId: string,
  deps: DashboardsDeps,
  options: { write: boolean } = { write: true },
): Promise<Actor | Refusal> {
  const actor = await deps.getActor();
  if (!actor) return refuse("signed_out", projectId);
  // Flag off reads as not found: the pages and their writes do not exist.
  if (!(await deps.isEnabled())) return refuse("not_found", projectId);
  const scope = await deps.findScope(projectId, actor.userId);
  if (!scope) return refuse("not_found", projectId);
  if (options.write && (await deps.isRestricted?.())) return refuse("restricted", projectId);
  return { externalId: actor.externalId, orgId: scope.organizationId };
}

async function track(
  deps: DashboardsDeps,
  event: DashboardEvent,
  actor: Actor,
  projectId: string,
  properties: Record<string, unknown>,
): Promise<void> {
  logger.info({ project_id: projectId, outcome: event, ...properties }, "dashboards changed");
  await deps.track?.(
    event,
    { externalId: actor.externalId, projectId, orgId: actor.orgId },
    properties,
  );
}

function refuse(code: DashboardErrorCode, projectId: string): Refusal {
  logger.info({ project_id: projectId, outcome: code }, "dashboards request refused");
  return { ok: false, code, error: DASHBOARD_ERRORS[code] };
}

function db(deps: DashboardsDeps): DashboardsDb {
  return deps.db ?? getDb();
}
