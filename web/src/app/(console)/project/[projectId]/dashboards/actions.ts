"use server";

import { revalidatePath } from "next/cache";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { getLogger } from "@/lib/platform/logger";
import { parseProjectUuid } from "@/lib/platform/projects/queries";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { reportServerException, trackServerEvent } from "@/lib/platform/telemetry";
import type { QueryResult } from "@/lib/synthesis/metrics/query";
import {
  changeDashboard,
  type DashboardActionInput,
  type DashboardActionResult,
} from "@/lib/views/dashboards/actions";
import { loadWidget } from "@/lib/views/dashboards/data";
import { type DashboardDocument, exportDashboard } from "@/lib/views/dashboards/document";
import {
  dashboardFiltersSchema,
  filtersProblem,
  filtersRefusal,
} from "@/lib/views/dashboards/filters";
import { dashboardsHref } from "@/lib/views/dashboards/links";
import { parseWidget } from "@/lib/views/dashboards/parse-widget";
import { resolveWidgetRange } from "@/lib/views/dashboards/range";
import * as store from "@/lib/views/dashboards/store";
import { isBroken } from "@/lib/views/dashboards/stored-widget";
import { scorerNames } from "@/lib/views/scorers/picker";
import { metricFeatures } from "./context";

const logger = getLogger("dashboards/actions");

export async function changeDashboardAction(
  input: DashboardActionInput,
): Promise<DashboardActionResult> {
  if (!isDbConfigured()) return { ok: false, error: "No database is connected." };
  try {
    return await changeDashboard(input, {
      getSession: getSessionContext,
      findProjectScope,
      enabled: (subject) => featureEnabled("customMonitoring", subject),
      features: metricFeatures,
      scorers: (projectId) => scorerNames(projectId),
      isRestricted: isRestrictedBySupportSession,
      store,
      observe: async (fields) => {
        logger.info(fields, "dashboard_changed");
        await trackServerEvent(
          "dashboard_changed",
          { externalId: fields.actor, projectId: fields.project_id, orgId: fields.organization_id },
          fields,
        );
        revalidatePath(dashboardsHref(fields.project_id), "layout");
      },
    });
  } catch (err) {
    logger.error({ err }, "dashboard change failed");
    reportServerException(err, "system:dashboards", { operation: "dashboard_change" });
    return { ok: false, error: "Could not save the change. Try again." };
  }
}

export type DashboardExport =
  | {
      ok: true;
      document: DashboardDocument;
      /** Broken widgets the document leaves out. */
      leftOut: number;
    }
  | { ok: false; error: string };

/** The saved dashboard as a document. */
export async function exportDashboardAction(
  projectId: string,
  dashboardId: string,
): Promise<DashboardExport> {
  if (!isDbConfigured()) return { ok: false, error: "No database is connected." };
  const scope = await findProjectScope(projectId);
  if (!scope) return { ok: false, error: "You cannot read this project." };
  if (!(await featureEnabled("customMonitoring", { organizationId: scope.organization.id })))
    return { ok: false, error: "Dashboards are off for this project." };
  const id = parseProjectUuid(dashboardId);
  try {
    const dashboard = id ? await store.getDashboard(scope.project.id, id) : null;
    if (!dashboard) return { ok: false, error: "This dashboard no longer exists." };
    return {
      ok: true,
      document: exportDashboard(dashboard, await scorerNames(scope.project.id)),
      leftOut: dashboard.widgets.filter(isBroken).length,
    };
  } catch (err) {
    logger.error({ err }, "dashboard export failed");
    reportServerException(err, "system:dashboards", { operation: "dashboard_export" });
    return { ok: false, error: "The dashboard could not be read. Try again." };
  }
}

export type WidgetPreview = { ok: true; result: QueryResult } | { ok: false; error: string };

/** The editor's live preview: the numbers a widget would show, before it is saved. */
export async function previewWidgetAction(
  projectId: string,
  widget: unknown,
  range: { preset: string; from: string; to: string },
  filters: unknown,
): Promise<WidgetPreview> {
  if (!isDbConfigured()) return { ok: false, error: "No database is connected." };
  const scope = await findProjectScope(projectId);
  if (!scope) return { ok: false, error: "You cannot read this project." };
  if (!(await featureEnabled("customMonitoring", { organizationId: scope.organization.id })))
    return { ok: false, error: "Dashboards are off for this project." };
  const features = await metricFeatures({
    projectId: scope.project.id,
    organizationId: scope.organization.id,
    actor: scope.user.externalId,
  });
  const parsed = parseWidget(widget, features);
  if (!parsed.ok) return parsed;
  const window = resolveWidgetRange(
    { range: String(range.preset), from: String(range.from), to: String(range.to) },
    new Date(),
  );
  const filter = dashboardFiltersSchema.safeParse(filters);
  if (!filter.success) return { ok: false, error: filtersRefusal(filter.error) };
  const problem = filtersProblem([parsed.widget.query], filter.data);
  if (problem) return { ok: false, error: problem };
  const result = await loadWidget(scope.project.id, parsed.widget, {
    ...window,
    filter: filter.data,
  });
  return result ? { ok: true, result } : { ok: false, error: "The numbers could not be read." };
}
