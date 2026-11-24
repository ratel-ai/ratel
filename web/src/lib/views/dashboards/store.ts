import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { dashboards } from "@/lib/views/dashboards/schema";
import type { Dashboard, Widget } from "@/lib/views/dashboards/types";

export type DashboardsDb = Pick<
  ReturnType<typeof getDb>,
  "select" | "insert" | "update" | "delete" | "transaction"
>;

const COLUMNS = {
  id: dashboards.id,
  name: dashboards.name,
  widgets: dashboards.widgets,
  updatedAt: dashboards.updatedAt,
};

/** Oldest first, so the list does not move as dashboards change. */
export async function listDashboards(
  projectId: string,
  db: DashboardsDb = getDb(),
): Promise<Dashboard[]> {
  return db
    .select(COLUMNS)
    .from(dashboards)
    .where(eq(dashboards.projectId, projectId))
    .orderBy(asc(dashboards.createdAt), asc(dashboards.id));
}

export async function getDashboard(
  projectId: string,
  id: string,
  db: DashboardsDb = getDb(),
): Promise<Dashboard | null> {
  const [row] = await db.select(COLUMNS).from(dashboards).where(inProject(projectId, id));
  return row ?? null;
}

export async function createDashboard(
  input: { projectId: string; name: string; widgets: Widget[]; updatedBy: string },
  db: DashboardsDb = getDb(),
): Promise<Dashboard> {
  const [row] = await db.insert(dashboards).values(input).returning(COLUMNS);
  return row;
}

/** False when the project has no such dashboard, as for every change below. */
export async function renameDashboard(
  input: { projectId: string; id: string; name: string; updatedBy: string },
  db: DashboardsDb = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(dashboards)
    .set({ name: input.name, updatedBy: input.updatedBy, updatedAt: sql`now()` })
    .where(inProject(input.projectId, input.id))
    .returning({ id: dashboards.id });
  return rows.length > 0;
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
 * next list, or null to leave it. The result says which.
 */
export async function changeWidgets(
  input: {
    projectId: string;
    id: string;
    updatedBy: string;
    change: (widgets: Widget[]) => Widget[] | null;
  },
  db: DashboardsDb = getDb(),
): Promise<"changed" | "unchanged" | "missing"> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ widgets: dashboards.widgets })
      .from(dashboards)
      .where(inProject(input.projectId, input.id))
      .for("update");
    if (!row) return "missing";
    const widgets = input.change(row.widgets);
    if (!widgets) return "unchanged";
    await tx
      .update(dashboards)
      .set({ widgets, updatedBy: input.updatedBy, updatedAt: sql`now()` })
      .where(inProject(input.projectId, input.id));
    return "changed";
  });
}

function inProject(projectId: string, id: string) {
  return and(eq(dashboards.projectId, projectId), eq(dashboards.id, id));
}
