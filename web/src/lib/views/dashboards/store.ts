import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { lockProjectScope } from "@/lib/platform/db/project-lock";
import { dashboards } from "@/lib/views/dashboards/schema";
import { readWidgets, writeWidgets } from "@/lib/views/dashboards/stored-widget";
import {
  type Dashboard,
  type DashboardDefaults,
  type DashboardEditor,
  type DashboardFilters,
  type DashboardSummary,
  type DashboardWidget,
  MAX_DASHBOARDS,
  type Widget,
} from "@/lib/views/dashboards/types";

export type DashboardsDb = Pick<
  ReturnType<typeof getDb>,
  "select" | "insert" | "update" | "delete" | "transaction"
>;

const COLUMNS = {
  id: dashboards.id,
  name: dashboards.name,
  widgets: dashboards.widgets,
  filters: dashboards.filters,
  range: dashboards.range,
  updatedAt: dashboards.updatedAt,
  updatedByName: dashboards.updatedByName,
};

/** Without the widgets themselves: oldest first, so the list does not move as dashboards change. */
export async function listDashboards(
  projectId: string,
  db: DashboardsDb = getDb(),
): Promise<DashboardSummary[]> {
  const { widgets, ...columns } = COLUMNS;
  return db
    .select({
      ...columns,
      widgetCount: sql<number>`case jsonb_typeof(${widgets}) when 'array' then jsonb_array_length(${widgets}) else 0 end`,
    })
    .from(dashboards)
    .where(eq(dashboards.projectId, projectId))
    .orderBy(asc(dashboards.createdAt), asc(dashboards.id));
}

export async function countDashboards(
  projectId: string,
  db: Pick<DashboardsDb, "select"> = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(dashboards)
    .where(eq(dashboards.projectId, projectId));
  return row?.count ?? 0;
}

export async function getDashboard(
  projectId: string,
  id: string,
  db: DashboardsDb = getDb(),
): Promise<Dashboard | null> {
  const [row] = await db.select(COLUMNS).from(dashboards).where(inProject(projectId, id));
  return row ? readDashboard(row) : null;
}

/** Those of the project, with their widgets; every one without `ids`. Oldest first. */
export async function getDashboards(
  projectId: string,
  ids?: readonly string[],
  db: Pick<DashboardsDb, "select"> = getDb(),
): Promise<Dashboard[]> {
  if (ids?.length === 0) return [];
  const rows = await db
    .select(COLUMNS)
    .from(dashboards)
    .where(
      and(eq(dashboards.projectId, projectId), ids ? inArray(dashboards.id, [...ids]) : undefined),
    )
    .orderBy(asc(dashboards.createdAt), asc(dashboards.id));
  return rows.map(readDashboard);
}

/**
 * Null when the project has `MAX_DASHBOARDS` already. The count and the insert are one transaction
 * under the project's lock, so creates at the same time never pass the limit.
 */
export async function createDashboard(
  input: { projectId: string; name: string; widgets: Widget[] } & Partial<DashboardDefaults> &
    DashboardEditor,
  db: DashboardsDb = getDb(),
): Promise<Dashboard | null> {
  return db.transaction(async (tx) => {
    await lockProjectScope(tx, "dashboards", input.projectId);
    if ((await countDashboards(input.projectId, tx)) >= MAX_DASHBOARDS) return null;
    const [row] = await tx.insert(dashboards).values(input).returning(COLUMNS);
    return readDashboard(row);
  });
}

/** Its name or what it opens with. False when the project has no such dashboard, as for every change below. */
export async function updateDashboard(
  input: {
    projectId: string;
    id: string;
    set: { name: string } | DashboardDefaults;
    /** May refuse, by a throw, for the widgets there are. */
    check?: (widgets: DashboardWidget[]) => void;
  } & DashboardEditor,
  db: DashboardsDb = getDb(),
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ widgets: dashboards.widgets })
      .from(dashboards)
      .where(inProject(input.projectId, input.id))
      .for("update");
    if (!row) return false;
    input.check?.(readWidgets(row.widgets));
    await tx
      .update(dashboards)
      .set({ ...input.set, ...changedBy(input) })
      .where(inProject(input.projectId, input.id));
    return true;
  });
}

export async function deleteDashboard(
  projectId: string,
  id: string,
  db: DashboardsDb = getDb(),
): Promise<boolean> {
  const rows = await db
    .delete(dashboards)
    .where(inProject(projectId, id))
    .returning({ id: dashboards.id });
  return rows.length > 0;
}

/**
 * Change the widget list under a row lock, so two people's edits both land. `change` returns the
 * next list.
 */
export async function changeWidgets(
  input: {
    projectId: string;
    id: string;
    change: (widgets: DashboardWidget[], filters: DashboardFilters) => DashboardWidget[];
  } & DashboardEditor,
  db: DashboardsDb = getDb(),
): Promise<"changed" | "missing"> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ widgets: dashboards.widgets, filters: dashboards.filters })
      .from(dashboards)
      .where(inProject(input.projectId, input.id))
      .for("update");
    if (!row) return "missing";
    const widgets = writeWidgets(input.change(readWidgets(row.widgets), row.filters));
    await tx
      .update(dashboards)
      .set({ widgets, ...changedBy(input) })
      .where(inProject(input.projectId, input.id));
    return "changed";
  });
}

function readDashboard(row: Omit<Dashboard, "widgets"> & { widgets: unknown }): Dashboard {
  return { ...row, widgets: readWidgets(row.widgets) };
}

function inProject(projectId: string, id: string) {
  return and(eq(dashboards.projectId, projectId), eq(dashboards.id, id));
}

function changedBy({ updatedBy, updatedByName }: DashboardEditor) {
  return { updatedBy, updatedByName, updatedAt: sql`now()` };
}
