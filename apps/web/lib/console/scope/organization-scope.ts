import { notFound } from "next/navigation";
import { cache } from "react";
import type { Organization, OrgRole, Session, SessionUser } from "@/lib/contracts/session";
import { getSessionContext, membershipBySlug } from "@/lib/platform/session";

/**
 * The reader's view of one organization: the organization and their role in it. Upstream's
 * `resolveOrganizationScope` (`resolvers.ts`): authorized by membership in that organization,
 * whichever one is active, which is neither consulted nor changed. Every organization page and
 * action reads it, so a link into any organization the reader belongs to opens.
 */
export interface OrganizationScope {
  organization: Organization;
  role: OrgRole;
  user: SessionUser;
}

/** The rule, given the session: null when the reader is not a member of the organization. */
export function resolveOrganizationScope(slug: string, session: Session): OrganizationScope | null {
  const membership = membershipBySlug(session, slug);
  return membership
    ? { organization: membership.organization, role: membership.role, user: session.user }
    : null;
}

/** Null when nobody is signed in, or under `resolveOrganizationScope`'s rule. */
export const findOrganizationScope = cache(
  async (slug: string): Promise<OrganizationScope | null> => {
    const session = await getSessionContext();
    return session ? resolveOrganizationScope(slug, session) : null;
  },
);

/** What a page calls: the scope, or a 404. */
export async function requireOrganizationScope(slug: string): Promise<OrganizationScope> {
  const scope = await findOrganizationScope(slug);
  if (!scope) notFound();
  return scope;
}
