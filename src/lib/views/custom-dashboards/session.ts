import { findProjectScope } from "@/lib/console/scope/project-scope";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { trackServerEvent } from "@/lib/platform/telemetry";
import type { DashboardsDeps } from "./service";

/**
 * The service deps bound to the signed-in session: the pages and the server
 * actions use them. Owned (ADR-0030): the console's project scope checks the
 * membership (the project's organization, from the session).
 */
export function sessionDashboardsDeps(): DashboardsDeps {
  return {
    getActor: async () => {
      const session = await getSessionContext();
      return session ? { userId: session.user.id, externalId: session.user.externalId } : null;
    },
    findScope: async (projectId) => {
      const scope = await findProjectScope(projectId);
      return scope ? { organizationId: scope.organization.id } : null;
    },
    isRestricted: isRestrictedBySupportSession,
    track: (event, context, properties) => trackServerEvent(event, context, properties),
  };
}
