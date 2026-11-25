"use server";

import { revalidatePath } from "next/cache";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { parseGeoAttributes } from "@/lib/ingest/geo/parse-attributes";
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
  const scope = await findProjectScope(projectId);
  if (!scope || scope.role !== "admin")
    return { ok: false, error: "Only organization admins can change the location attributes." };
  if (!(await featureEnabled("customMonitoring", { organizationId: scope.organization.id })))
    return { ok: false, error: "Locations are off for this project." };
  if (await isRestrictedBySupportSession())
    return { ok: false, error: "A support session cannot change settings." };
  const parsed = parseGeoAttributes(raw);
  if (!parsed.ok) return parsed;
  try {
    await saveGeoAttributes(scope.project.id, parsed.attributes);
    await trackProductEvent(
      "project_settings_updated",
      {
        externalId: scope.user.externalId,
        orgId: scope.organization.id,
        projectId: scope.project.id,
      },
      { field: "geo_attributes" },
    );
    revalidatePath(`/project/${scope.project.id}/settings`);
    return { ok: true };
  } catch (err) {
    logger.error({ err }, "geo attributes save failed");
    reportServerException(err, "system:settings", { operation: "geo_attributes" });
    return { ok: false, error: "Could not save. Try again." };
  }
}
