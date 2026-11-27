"use server";

import { revalidatePath } from "next/cache";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { changeGeoAttributes } from "@/lib/ingest/geo/actions";
import { saveGeoAttributes } from "@/lib/ingest/geo/store";
import { isDbConfigured } from "@/lib/platform/db/client";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { getLogger } from "@/lib/platform/logger";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { reportServerException, trackProductEvent } from "@/lib/platform/telemetry";

const logger = getLogger("settings/geo");

/** The attributes a project's locations are read from, by an admin. */
export async function saveGeoAttributesAction(
  projectId: string,
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isDbConfigured()) return { ok: false, error: "No database is connected." };
  try {
    const result = await changeGeoAttributes(projectId, raw, {
      findProjectScope: (id) => findProjectScope(id),
      enabled: (subject) => featureEnabled("customMonitoring", subject),
      isRestricted: isRestrictedBySupportSession,
      save: (id, attributes) => saveGeoAttributes(id, attributes),
      observe: async ({ project_id, organization_id, field }) => {
        const scope = await findProjectScope(project_id);
        await trackProductEvent(
          "project_settings_updated",
          {
            externalId: scope?.user.externalId ?? "",
            orgId: organization_id,
            projectId: project_id,
          },
          { field },
        );
        revalidatePath(`/project/${project_id}/settings`);
      },
    });
    return result.ok ? { ok: true } : result;
  } catch (err) {
    logger.error({ err }, "geo attributes save failed");
    reportServerException(err, "system:settings", { operation: "geo_attributes" });
    return { ok: false, error: "Could not save. Try again." };
  }
}
