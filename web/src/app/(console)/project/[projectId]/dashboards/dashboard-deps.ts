import { revalidatePath } from "next/cache";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { getLogger } from "@/lib/platform/logger";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { followDashboardChange } from "@/lib/views/ask/store";
import type { DashboardActionDeps } from "@/lib/views/dashboards/actions";
import { dashboardsHref } from "@/lib/views/dashboards/links";
import * as store from "@/lib/views/dashboards/store";
import { templateActionDeps } from "@/lib/views/dashboards/templates/store";
import { scorerNames } from "@/lib/views/scorers/picker";

const logger = getLogger("dashboards/actions");

/**
 * What a dashboard change of the console stands on: the session, the store, the event,
 * and Ask in words following the outcome of the asks that made the dashboard. Server only.
 */
export function consoleDashboardDeps(): DashboardActionDeps {
  return {
    getSession: getSessionContext,
    findProjectScope,
    scorers: (projectId) => scorerNames(projectId),
    isRestricted: isRestrictedBySupportSession,
    templates: templateActionDeps(),
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
    afterChange: (change) => followDashboardChange(change),
  };
}
