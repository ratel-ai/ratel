"use server";

import { revalidatePath } from "next/cache";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { changeTraceProperty, type TracePropertyResult } from "@/lib/ingest/properties/actions";
import { isDbConfigured } from "@/lib/platform/db/client";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { getLogger } from "@/lib/platform/logger";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { reportServerException, trackProductEvent } from "@/lib/platform/telemetry";
import { tracePropertyStorage } from "@/lib/synthesis/traces/property-storage";

const logger = getLogger("settings/trace-properties");

/** Index a trace property, stop it or erase its values, by an admin (RTL-395). */
export async function changeTracePropertyAction(
  projectId: string,
  raw: unknown,
): Promise<TracePropertyResult> {
  if (!isDbConfigured())
    return { ok: false, reason: "invalid", error: "No database is connected." };
  try {
    return await changeTraceProperty(projectId, raw, {
      ...tracePropertyStorage(),
      findProjectScope: (id) => findProjectScope(id),
      enabled: (subject) => featureEnabled("customMonitoring", subject),
      isRestricted: isRestrictedBySupportSession,
      observe: async ({ project_id, organization_id, field, action }) => {
        const scope = await findProjectScope(project_id);
        await trackProductEvent(
          "project_settings_updated",
          {
            externalId: scope?.user.externalId ?? "",
            orgId: organization_id,
            projectId: project_id,
          },
          { field, action },
        );
        revalidatePath(`/project/${project_id}/settings`);
      },
    });
  } catch (err) {
    logger.error({ err }, "trace property change failed");
    reportServerException(err, "system:settings", { operation: "trace_properties" });
    return { ok: false, reason: "invalid", error: "Could not save. Try again." };
  }
}
