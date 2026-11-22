import { findProjectScope } from "@/lib/console/scope/project-scope";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { CUSTOM_DASHBOARDS_FLAG, customDashboardsEnabledFor } from "./flag";
import type { DashboardsDeps } from "./service";

export { CUSTOM_DASHBOARDS_FLAG };

/**
 * `FF_CUSTOM_DASHBOARDS` (RC-887) for the signed-in person, as upstream reads its session flag
 * `cloud-custom-dashboards`. Owned (ADR-0030): the core's switch through `featureEnabled`, with
 * the person's identity-provider id as the subject; off with no session or a failed decision.
 */
export async function customDashboardsEnabled(): Promise<boolean> {
  const session = await getSessionContext();
  return customDashboardsEnabledFor(session ? { actor: session.user.externalId } : {});
}

/**
 * The service deps bound to the signed-in session: the pages and the server
 * actions use them. A page that read the switch already passes `flagChecked`, so
 * the switch is read once per page. Owned (ADR-0030): the console's project
 * scope checks the membership (the project's organization, from the session).
 */
export function sessionDashboardsDeps(options: { flagChecked?: boolean } = {}): DashboardsDeps {
  return {
    getActor: async () => {
      const session = await getSessionContext();
      return session ? { userId: session.user.id, externalId: session.user.externalId } : null;
    },
    findScope: async (projectId) => {
      const scope = await findProjectScope(projectId);
      return scope ? { organizationId: scope.organization.id } : null;
    },
    isEnabled: options.flagChecked ? async () => true : customDashboardsEnabled,
    isRestricted: isRestrictedBySupportSession,
    track: (event, context, properties) => trackServerEvent(event, context, properties),
  };
}
