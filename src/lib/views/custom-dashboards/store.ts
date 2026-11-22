import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import { dashboards, dashboardWidgets } from "@/lib/views/custom-dashboards/schema";
import { type Dashboard, type DashboardSharing, type DashboardWidget, WIDGET_LIMIT } from "./model";

/**
 * The DB adapter of custom dashboards (RC-888). Every statement is scoped to
 * one project, and every widget statement to one dashboard of it. The rules
 * live in `./model`.
 */

export type DashboardsDb = ReturnType<typeof getDb>;

export type WidgetInsertOutcome =
  | { outcome: "inserted"; id: string }
  | { outcome: "limit" }
  | { outcome: "missing" };

const DASHBOARD_COLUMNS = {
  id: dashboards.id,
  projectId: dashboards.projectId,
  name: dashboards.name,
  createdBy: dashboards.createdBy,
  sharing: dashboards.sharing,
  createdAt: dashboards.createdAt,
  updatedAt: dashboards.updatedAt,
};

/**
 * The project's dashboards a member opens (theirs, and those shared with the
 * project), newest first. With no person (null: a project API key), only the
 * shared ones. The same rule as `canOpenDashboard`.
 */
export async function listOpenDashboards(
  projectId: string,
  externalId: string | null,
  db: DashboardsDb,
): Promise<Dashboard[]> {
  const shared = eq(dashboards.sharing, "project");
  return db
    .select(DASHBOARD_COLUMNS)
    .from(dashboards)
    .where(
      and(
        eq(dashboards.projectId, projectId),
        externalId === null ? shared : or(eq(dashboards.createdBy, externalId), shared),
      ),
    )
    .orderBy(desc(dashboards.createdAt), asc(dashboards.id));
}

/** One dashboard of the project, whoever may open it. */
export async function findDashboard(
  projectId: string,
  dashboardId: string,
  db: DashboardsDb,
): Promise<Dashboard | null> {
  if (!isUuid(dashboardId)) return null;
  const [row] = await db
    .select(DASHBOARD_COLUMNS)
    .from(dashboards)
    .where(and(eq(dashboards.projectId, projectId), eq(dashboards.id, dashboardId)))
    .limit(1);
  return row ?? null;
}

export async function insertDashboard(
  projectId: string,
  name: string,
  externalId: string,
  db: DashboardsDb,
): Promise<Dashboard> {
  const [row] = await db
    .insert(dashboards)
    .values({ projectId, name, createdBy: externalId })
    .returning(DASHBOARD_COLUMNS);
  return row;
}

export async function updateDashboardName(
  projectId: string,
  dashboardId: string,
  name: string,
  db: DashboardsDb,
): Promise<boolean> {
  const rows = await db
    .update(dashboards)
    .set({ name, updatedAt: new Date() })
    .where(and(eq(dashboards.projectId, projectId), eq(dashboards.id, dashboardId)))
    .returning({ id: dashboards.id });
  return rows.length > 0;
}

export async function updateDashboardSharing(
  projectId: string,
  dashboardId: string,
  sharing: DashboardSharing,
  db: DashboardsDb,
): Promise<boolean> {
  const rows = await db
    .update(dashboards)
    .set({ sharing, updatedAt: new Date() })
    .where(and(eq(dashboards.projectId, projectId), eq(dashboards.id, dashboardId)))
    .returning({ id: dashboards.id });
  return rows.length > 0;
}

/** Delete a dashboard; its widgets go with it (ON DELETE CASCADE). */
export async function deleteDashboard(
  projectId: string,
  dashboardId: string,
  db: DashboardsDb,
): Promise<boolean> {
  const rows = await db
    .delete(dashboards)
    .where(and(eq(dashboards.projectId, projectId), eq(dashboards.id, dashboardId)))
    .returning({ id: dashboards.id });
  return rows.length > 0;
}

/** A dashboard's widgets in display order. */
export async function listWidgets(
  dashboardId: string,
  db: DashboardsDb,
): Promise<DashboardWidget[]> {
  return db
    .select({
      id: dashboardWidgets.id,
      position: dashboardWidgets.position,
      spec: dashboardWidgets.spec,
    })
    .from(dashboardWidgets)
    .where(eq(dashboardWidgets.dashboardId, dashboardId))
    .orderBy(asc(dashboardWidgets.position), asc(dashboardWidgets.createdAt));
}

/**
 * Add a widget as the last one. The statement locks the dashboard row and
 * keeps the limit itself, so two adds at the same time cannot pass it.
 */
export async function insertWidget(
  projectId: string,
  dashboardId: string,
  spec: unknown,
  db: DashboardsDb,
): Promise<WidgetInsertOutcome> {
  if (!isUuid(dashboardId)) return { outcome: "missing" };
  const result = await db.execute<{
    id: string | null;
    widgets: number | string;
    found: boolean;
  }>(sql`
    with d as (
      select id from dashboards where id = ${dashboardId} and project_id = ${projectId} for update
    ),
    counted as (
      select count(w.id)::int as widgets, coalesce(max(w.position) + 1, 0) as next
      from d left join dashboard_widgets w on w.dashboard_id = d.id
    ),
    inserted as (
      insert into dashboard_widgets (dashboard_id, position, spec)
      select d.id, counted.next, ${JSON.stringify(spec)}::jsonb
      from d, counted
      where counted.widgets < ${WIDGET_LIMIT}
      returning id
    )
    select (select id from inserted) as id, counted.widgets, exists (select 1 from d) as found from counted`);
  const row = rowsOf<{ id: string | null; widgets: number | string; found: boolean }>(result)[0];
  if (!row?.found) return { outcome: "missing" };
  return row.id ? { outcome: "inserted", id: row.id } : { outcome: "limit" };
}

export async function updateWidgetSpec(
  dashboardId: string,
  widgetId: string,
  spec: unknown,
  db: DashboardsDb,
): Promise<boolean> {
  if (!isUuid(widgetId)) return false;
  const rows = await db
    .update(dashboardWidgets)
    .set({ spec, updatedAt: new Date() })
    .where(and(eq(dashboardWidgets.dashboardId, dashboardId), eq(dashboardWidgets.id, widgetId)))
    .returning({ id: dashboardWidgets.id });
  return rows.length > 0;
}

export async function deleteWidget(
  dashboardId: string,
  widgetId: string,
  db: DashboardsDb,
): Promise<boolean> {
  if (!isUuid(widgetId)) return false;
  const rows = await db
    .delete(dashboardWidgets)
    .where(and(eq(dashboardWidgets.dashboardId, dashboardId), eq(dashboardWidgets.id, widgetId)))
    .returning({ id: dashboardWidgets.id });
  return rows.length > 0;
}

/** Write the order as positions 0..n-1, in one statement. False when an id is not a widget of the dashboard. */
export async function setWidgetOrder(
  dashboardId: string,
  ids: readonly string[],
  db: DashboardsDb,
): Promise<boolean> {
  if (ids.length === 0 || !ids.every(isUuid)) return false;
  const values = sql.join(
    ids.map((id, position) => sql`(${id}::uuid, ${position}::int)`),
    sql`, `,
  );
  const result = await db.execute<{ id: string }>(sql`
    update dashboard_widgets w set position = o.position, updated_at = now()
    from (values ${values}) as o(id, position)
    where w.dashboard_id = ${dashboardId} and w.id = o.id
    returning w.id`);
  return rowsOf(result).length === ids.length;
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
