import { getDb } from "@/lib/platform/db/client";
import { publicUrl } from "@/lib/platform/public-url";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { createDrizzleBaselineStore } from "./adapters/drizzle-baseline-store";
import { createDrizzleExperimentStore } from "./adapters/drizzle-experiment-store";
import type { BaselineDeps } from "./baseline";
import type { BaselineApiDeps, BaselineConsoleDeps } from "./baseline-api";
import { evalsAccess } from "./console-deps";

export function baselineDeps(): BaselineDeps {
  const db = getDb();
  return {
    baselines: createDrizzleBaselineStore(db),
    experiments: createDrizzleExperimentStore(db),
    now: () => new Date(),
  };
}

export const baselineApiDeps: BaselineApiDeps = {
  baselines: baselineDeps,
  track: (name, { projectId, organizationId }, { externalId, surface }) =>
    trackServerEvent(
      name,
      externalId
        ? { externalId, projectId, orgId: organizationId }
        : { projectId, orgId: organizationId },
      { object_action: name, surface },
    ),
  publicUrl,
};

export const consoleBaselineDeps: BaselineConsoleDeps = { ...baselineApiDeps, ...evalsAccess };
