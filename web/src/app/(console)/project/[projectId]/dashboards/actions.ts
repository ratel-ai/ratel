"use server";

import { revalidatePath } from "next/cache";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { getLogger } from "@/lib/platform/logger";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { reportServerException, trackServerEvent } from "@/lib/platform/telemetry";
import type { MetricResult } from "@/lib/synthesis/metrics/query";
import { resolveTraceRange } from "@/lib/synthesis/traces/view";
import {
  changeDashboard,
  type DashboardActionInput,
  type DashboardActionResult,
} from "@/lib/views/dashboards/actions";
import { loadWidget } from "@/lib/views/dashboards/data";
import { dashboardsHref } from "@/lib/views/dashboards/links";
import { parseWidget } from "@/lib/views/dashboards/parse-widget";
import * as store from "@/lib/views/dashboards/store";

const logger = getLogger("dashboards/actions");

export async function changeDashboardAction(
  input: DashboardActionInput,
): Promise<DashboardActionResult> {
  if (!isDbConfigured()) return { ok: false, error: "No database is connected." };
  try {
    return await changeDashboard(input, {
      getSession: getSessionContext,
      findProjectScope,
      enabled: (subject) => featureEnabled("customDashboards", subject),
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

export type WidgetPreview = { ok: true; result: MetricResult } | { ok: false; error: string };

/** The editor's live preview: the numbers a widget would show, before it is saved. */
export async function previewWidgetAction(
  projectId: string,
  widget: unknown,
  range: { preset: string; from: string; to: string },
): Promise<WidgetPreview> {
  if (!isDbConfigured()) return { ok: false, error: "No database is connected." };
  const scope = await findProjectScope(projectId);
  if (!scope) return { ok: false, error: "You cannot read this project." };
  if (!(await featureEnabled("customDashboards", { organizationId: scope.organization.id })))
    return { ok: false, error: "Dashboards are off for this project." };
  const parsed = parseWidget(widget);
  if (!parsed.ok) return parsed;
  const window = resolveTraceRange(
    { range: String(range.preset), from: String(range.from), to: String(range.to) },
    new Date(),
  );
  const result = await loadWidget(scope.project.id, parsed.widget, window);
  return result ? { ok: true, result } : { ok: false, error: "The numbers could not be read." };
}
