import { SUPPORT_SESSION_RESTRICTED_MESSAGE } from "@/lib/console/onboarding/create-first-project";
import type { ActingAs } from "@/lib/contracts/session";
import type { OrganizationDeletionResult, OrgLimitView } from "@/lib/platform/entitlements";
import type { OrgRole } from "@/lib/platform/organization";
import type { trackProductEvent } from "@/lib/platform/telemetry";

export type DeleteOrganizationResult = { ok: true; next: string } | { ok: false; error: string };

export type DeleteOrganizationSession = {
  user: { externalId: string };
  organization: OrgLimitView & { name: string; slug: string };
  role: OrgRole;
};

export type DeleteOrganizationDeps = {
  /** The session port's support session; any value refuses the delete. */
  actingAs: () => Promise<ActingAs>;
  /** The session organization and the reader's role in it; null when signed out. */
  session: () => Promise<DeleteOrganizationSession | null>;
  /** The entitlements port: an edition with billing refuses while a subscription is live. */
  checkDeletion: (organization: OrgLimitView) => OrganizationDeletionResult;
  deleteOrganization: (organizationId: string) => Promise<void>;
  track: typeof trackProductEvent;
};

/** Where a deleted organization's admin lands: the console entry, which opens onboarding. */
export const AFTER_DELETE_ROUTE = "/";

/**
 * Permanently deletes the session organization and everything it owns (projects, API keys,
 * ingested events, memberships) via ON DELETE cascade, once its name is typed back. Upstream's
 * refusals, in upstream's order: a support session, a stale session, a non-admin, a live
 * subscription (the entitlements port's answer), a mismatched name. One organization per session
 * here, so another organization's id reads as "not an admin of it", as a non-member's would.
 * The next request provisions an empty organization again.
 */
export async function deleteConsoleOrganization(
  organizationId: string,
  confirmName: string,
  deps: DeleteOrganizationDeps,
): Promise<DeleteOrganizationResult> {
  if (await deps.actingAs()) {
    return { ok: false, error: SUPPORT_SESSION_RESTRICTED_MESSAGE };
  }

  const session = await deps.session();
  if (!session) return { ok: false, error: "Your session has expired. Sign in again." };

  const { organization } = session;
  if (organizationId !== organization.id || session.role !== "admin") {
    return { ok: false, error: "Only organization admins can delete it." };
  }

  const deletion = deps.checkDeletion(organization);
  if (!deletion.ok) return { ok: false, error: deletion.message };

  if (confirmName.trim() !== organization.name) {
    return { ok: false, error: "The name you typed doesn't match this organization." };
  }

  await deps.deleteOrganization(organization.id);
  await deps.track(
    "organization_deleted",
    { externalId: session.user.externalId, orgId: organization.id },
    { organization_slug: organization.slug },
  );
  return { ok: true, next: AFTER_DELETE_ROUTE };
}
