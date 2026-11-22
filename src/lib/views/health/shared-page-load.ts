import { cache } from "react";
import { composition } from "@/lib/composition";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";
import {
  loadSharedHealth,
  type SharedHealth,
  sharedHealthDeps,
} from "@/lib/views/health/shared-load";

const logger = getLogger("health/share-page");

/**
 * One read per request for a shared page and its metadata (upstream's `share/page-load.ts`).
 * Owned (ADR-0030): share links are the edition's, so an edition without `EditionUi.HealthShare`
 * (the open-source one) answers every token like an unknown link. A failure is logged and
 * reported, then answered the same way, so an outage never says whether a token exists.
 */
export const sharedHealthFor = cache(async (token: string): Promise<SharedHealth | null> => {
  if (!isDbConfigured()) return null;
  const share = (await composition.ui?.())?.HealthShare;
  if (!share) return null;
  try {
    return await loadSharedHealth(
      token,
      sharedHealthDeps((value) => share.resolve(value)),
    );
  } catch (err) {
    logger.error({ err }, "shared health page load failed");
    reportServerException(err, "system:health-share", { operation: "health_share_load" });
    return null;
  }
});

/** Counts one view of a shared page through the edition. Best effort: never throws. */
export async function recordSharedHealthView(shared: SharedHealth): Promise<void> {
  try {
    await (await composition.ui?.())?.HealthShare?.recordView(shared.linkId);
  } catch (err) {
    logger.error({ err, project_id: shared.projectId }, "health share view count failed");
    reportServerException(err, `project:${shared.projectId}`, {
      project_id: shared.projectId,
      operation: "health_share_view_count",
    });
  }
}
