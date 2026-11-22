"use server";

import { revalidatePath } from "next/cache";
import { projectRoot } from "@/lib/console/navigation";
import {
  addWidget,
  createDashboard,
  type DashboardResult,
  removeDashboard,
  removeWidget,
  renameDashboard,
  reorderWidget,
  shareDashboard,
  updateWidget,
} from "./service";
import { sessionDashboardsDeps } from "./session";

/**
 * Server actions of custom dashboards (RC-888). The checks live in
 * `./service`; this file binds the signed-in session to them.
 */

export async function createDashboardAction(
  projectId: string,
  name: string,
): Promise<DashboardResult<{ dashboardId: string }>> {
  const result = await createDashboard(projectId, name, sessionDashboardsDeps());
  if (!result.ok) return result;
  revalidatePath(dashboardsPath(projectId));
  return { ok: true, dashboardId: result.dashboard.id };
}

export async function renameDashboardAction(
  projectId: string,
  dashboardId: string,
  name: string,
): Promise<DashboardResult<object>> {
  return revalidated(
    projectId,
    dashboardId,
    await renameDashboard(projectId, dashboardId, name, sessionDashboardsDeps()),
  );
}

export async function shareDashboardAction(
  projectId: string,
  dashboardId: string,
  sharing: "private" | "project",
): Promise<DashboardResult<object>> {
  return revalidated(
    projectId,
    dashboardId,
    await shareDashboard(projectId, dashboardId, sharing, sessionDashboardsDeps()),
  );
}

export async function deleteDashboardAction(
  projectId: string,
  dashboardId: string,
): Promise<DashboardResult<object>> {
  return revalidated(
    projectId,
    dashboardId,
    await removeDashboard(projectId, dashboardId, sessionDashboardsDeps()),
  );
}

export async function addWidgetAction(
  projectId: string,
  dashboardId: string,
  spec: unknown,
): Promise<DashboardResult<{ widgetId: string }>> {
  return revalidated(
    projectId,
    dashboardId,
    await addWidget(projectId, dashboardId, spec, sessionDashboardsDeps()),
  );
}

export async function updateWidgetAction(
  projectId: string,
  dashboardId: string,
  widgetId: string,
  spec: unknown,
): Promise<DashboardResult<object>> {
  return revalidated(
    projectId,
    dashboardId,
    await updateWidget(projectId, dashboardId, widgetId, spec, sessionDashboardsDeps()),
  );
}

export async function moveWidgetAction(
  projectId: string,
  dashboardId: string,
  widgetId: string,
  direction: "up" | "down",
): Promise<DashboardResult<object>> {
  const move = direction === "up" ? "up" : "down";
  return revalidated(
    projectId,
    dashboardId,
    await reorderWidget(projectId, dashboardId, widgetId, move, sessionDashboardsDeps()),
  );
}

export async function removeWidgetAction(
  projectId: string,
  dashboardId: string,
  widgetId: string,
): Promise<DashboardResult<object>> {
  return revalidated(
    projectId,
    dashboardId,
    await removeWidget(projectId, dashboardId, widgetId, sessionDashboardsDeps()),
  );
}

function revalidated<T extends DashboardResult<object>>(
  projectId: string,
  dashboardId: string,
  result: T,
): T {
  if (result.ok) {
    revalidatePath(dashboardsPath(projectId));
    revalidatePath(`${dashboardsPath(projectId)}/${encodeURIComponent(dashboardId)}`);
  }
  return result;
}

function dashboardsPath(projectId: string): string {
  return `${projectRoot(projectId)}/dashboards`;
}
