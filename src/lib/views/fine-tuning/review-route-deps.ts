import { findProjectScope } from "@/lib/console/scope/project-scope";
import { getDb } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import {
  createDrizzleDatasetStore,
  createDrizzleOverrideStore,
} from "./adapters/drizzle-dataset-store";
import type { ExportApiDeps } from "./export-api";
import { fineTuningEnabled } from "./flag";
import type { ReviewApiDeps } from "./review-api";
import { trackDatasetLifecycleEvent, trackOverrideEvent } from "./review-events";

/** What the rows and overrides routes (RC-1130) run on. */
export const reviewRouteDeps: ReviewApiDeps = {
  getSession: getSessionContext,
  findProjectScope,
  fineTuningEnabled: (organization) => fineTuningEnabled(organization),
  isRestricted: isRestrictedBySupportSession,
  datasets: () => createDrizzleDatasetStore(getDb()),
  overrides: () => createDrizzleOverrideStore(getDb()),
  track: (event, actor) =>
    trackOverrideEvent(
      event,
      { externalId: actor.externalId, projectId: event.projectId, orgId: actor.organizationId },
      "console",
    ),
};

/** What the export and delete routes (RC-1131) run on. */
export const exportRouteDeps: ExportApiDeps = {
  getSession: getSessionContext,
  findProjectScope,
  fineTuningEnabled: (organization) => fineTuningEnabled(organization),
  isRestricted: isRestrictedBySupportSession,
  datasets: () => createDrizzleDatasetStore(getDb()),
  track: (event, actor) =>
    trackDatasetLifecycleEvent(
      event,
      { externalId: actor.externalId, projectId: event.projectId, orgId: actor.organizationId },
      "console",
    ),
};
