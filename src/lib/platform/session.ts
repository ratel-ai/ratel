import { cache } from "react";
import { composition } from "@/lib/composition/ports";
import type { Session } from "@/lib/contracts/session";

/**
 * The session for this request, shared by every layout and page that renders it (React
 * `cache`). Owned port of upstream `auth-user.ts`: identity, organizations and memberships are
 * the edition's module, behind the session port, so the core reads no identity table.
 * Callers must check `isDbConfigured()` before invoking, as upstream's did.
 */
export type SessionContext = Session;

export const getSessionContext = cache(
  async (): Promise<SessionContext | null> => composition.session.resolveSession(),
);

/** Upstream kept a second resolver for flag evaluation; there are no flags here. */
export const getFlagSessionContext = getSessionContext;

/**
 * The reader's membership in one organization, or null when they are not a member. Upstream
 * authorizes a project or an organization page by membership in that organization, whichever
 * one is active (`resolvers.ts`); the open-source session has one membership, its own.
 */
export function membershipIn(
  session: Pick<Session, "memberships">,
  organizationId: string,
): Session["memberships"][number] | null {
  return session.memberships.find((m) => m.organization.id === organizationId) ?? null;
}

/** The same, for an organization named by its URL slug. */
export function membershipBySlug(
  session: Pick<Session, "memberships">,
  slug: string,
): Session["memberships"][number] | null {
  return session.memberships.find((m) => m.organization.slug === slug) ?? null;
}

/**
 * Upstream's `sessionForOrganization` (`scope/action-context.ts`): the session as seen from one
 * organization the reader belongs to, with their role there; the session itself when no id or
 * the active one is named; null for an organization they are not a member of.
 */
export function sessionForOrganization<S extends Session>(
  session: S,
  organizationId?: string,
): S | null {
  if (!organizationId || organizationId === session.organization.id) return session;
  const membership = membershipIn(session, organizationId);
  return membership
    ? { ...session, organization: membership.organization, role: membership.role }
    : null;
}
