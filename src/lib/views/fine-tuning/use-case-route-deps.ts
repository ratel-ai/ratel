import { findProjectScope } from "@/lib/console/scope/project-scope";
import { getDb } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { createDrizzleUseCaseStore } from "./adapters/drizzle-store";
import { fineTuningEnabled } from "./flag";
import type { UseCaseApiDeps } from "./use-cases-api";

/** What both use case routes (RC-1124) run on. */
export const useCaseRouteDeps: UseCaseApiDeps = {
  getSession: getSessionContext,
  findProjectScope,
  fineTuningEnabled: (organization) => fineTuningEnabled(organization),
  isRestricted: isRestrictedBySupportSession,
  store: () => createDrizzleUseCaseStore(getDb()),
  track: ({ name, externalId, projectId, organizationId, useCase }) =>
    trackServerEvent(
      name,
      { externalId, projectId, orgId: organizationId },
      {
        object_action: name,
        use_case_id: useCase.id,
        tasks: useCase.selector.taskIds.length,
        intents: useCase.selector.intentIds.length,
        call_filter: useCase.selector.callFilter !== undefined,
        surface: "console",
      },
    ),
};
