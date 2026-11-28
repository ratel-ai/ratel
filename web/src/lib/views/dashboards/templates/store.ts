import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { loadStoredPropertyNames } from "@/lib/ingest/properties/store";
import { getDb } from "@/lib/platform/db/client";
import { lockProjectScope } from "@/lib/platform/db/project-lock";
import type { DashboardActionDeps } from "@/lib/views/dashboards/actions";
import { dashboards } from "@/lib/views/dashboards/schema";
import type { DashboardsDb } from "@/lib/views/dashboards/store";
import { writeWidgets } from "@/lib/views/dashboards/stored-widget";
import { DEFAULT_TEMPLATE_IDS, templateDashboard } from "@/lib/views/dashboards/templates";
import { dashboardTemplateUses } from "@/lib/views/dashboards/templates/schema";
import { MAX_DASHBOARDS } from "@/lib/views/dashboards/types";

/** How a default is signed: Ratel made it, no person. The list shows it as its author. */
export const SYSTEM_EDITOR = { updatedBy: "system", updatedByName: "Ratel" } as const;

/**
 * Gives the project the default dashboards (Tools, Cost and Reliability) it did not get yet, as
 * normal dashboards, in one transaction under the project's dashboards lock, and records each one
 * as given. A default given before is never made again, even after its dashboard is deleted. A
 * project at `MAX_DASHBOARDS` gets none and gets them later. Returns the ids of the dashboards it
 * made. The caller never calls it in a support session.
 */
export async function ensureDefaultDashboards(
  projectId: string,
  db: DashboardsDb = getDb(),
): Promise<string[]> {
  // Read on every list: a project that has its defaults takes no lock.
  if ((await givenDefaults(projectId, db)).length === DEFAULT_TEMPLATE_IDS.length) return [];
  return db.transaction(async (tx) => {
    await lockProjectScope(tx, "dashboards", projectId);
    const given = new Set(await givenDefaults(projectId, tx));
    const [counted] = await tx
      .select({ count: count() })
      .from(dashboards)
      .where(eq(dashboards.projectId, projectId));
    let room = MAX_DASHBOARDS - (counted?.count ?? 0);
    const made: string[] = [];
    for (const [order, templateId] of DEFAULT_TEMPLATE_IDS.entries()) {
      if (given.has(templateId) || room <= 0) continue;
      const dashboard = templateDashboard(templateId, { indexed: [] });
      if (!dashboard.ok) throw new Error(dashboard.error);
      const [row] = await tx
        .insert(dashboards)
        .values({
          projectId,
          name: dashboard.name,
          widgets: writeWidgets(dashboard.widgets),
          ...SYSTEM_EDITOR,
          // The list is oldest first: the defaults keep the order of the gallery.
          createdAt: sql`now() + ${order} * interval '1 millisecond'`,
        })
        .returning({ id: dashboards.id });
      await tx.insert(dashboardTemplateUses).values({
        projectId,
        templateId,
        dashboardId: row.id,
        given: "default",
        actor: SYSTEM_EDITOR.updatedBy,
      });
      made.push(row.id);
      room -= 1;
    }
    return made;
  });
}

/** Records that a person or an agent made a dashboard from a template: a kept signal of Ask. */
export async function recordTemplatePick(
  input: { projectId: string; templateId: string; dashboardId: string; actor: string },
  db: Pick<DashboardsDb, "insert"> = getDb(),
): Promise<void> {
  await db.insert(dashboardTemplateUses).values({ ...input, given: "picked" });
}

/** The templates the project's people and agents picked, newest first. */
export async function listTemplatePicks(
  projectId: string,
  limit: number,
  db: Pick<DashboardsDb, "select"> = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ templateId: dashboardTemplateUses.templateId })
    .from(dashboardTemplateUses)
    .where(
      and(
        eq(dashboardTemplateUses.projectId, projectId),
        eq(dashboardTemplateUses.given, "picked"),
      ),
    )
    .orderBy(desc(dashboardTemplateUses.createdAt), desc(dashboardTemplateUses.id))
    .limit(limit);
  return rows.map(({ templateId }) => templateId);
}

async function givenDefaults(projectId: string, db: Pick<DashboardsDb, "select">) {
  const rows = await db
    .select({ templateId: dashboardTemplateUses.templateId })
    .from(dashboardTemplateUses)
    .where(
      and(
        eq(dashboardTemplateUses.projectId, projectId),
        eq(dashboardTemplateUses.given, "default"),
        inArray(dashboardTemplateUses.templateId, [...DEFAULT_TEMPLATE_IDS]),
      ),
    );
  return rows.map(({ templateId }) => templateId);
}

/** What the dashboard actions read and write for a template, on `db`. */
export function templateActionDeps(
  db: Pick<DashboardsDb, "insert"> & Pick<ReturnType<typeof getDb>, "execute"> = getDb(),
): DashboardActionDeps["templates"] {
  return {
    indexedProperties: async (projectId) => (await loadStoredPropertyNames(projectId, db)).indexed,
    recordPick: (pick) => recordTemplatePick(pick, db),
  };
}
