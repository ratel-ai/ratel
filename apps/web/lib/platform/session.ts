import { cache } from "react";
import { composition } from "@/lib/composition/ports";
import type { ActingAs, Principal } from "@/lib/contracts/session";
import {
  ensurePersonalOrganization,
  getOrganizationById,
  getUserById,
  listOrganizationsForUser,
  type MembershipView,
  setCurrentOrganization,
  upsertUserByExternalId,
} from "@/lib/platform/identity/queries";
import type { Organization, User } from "@/lib/platform/identity/schema";
import { type OrgRole, slugify } from "@/lib/platform/organization";
import { trackProductEvent } from "@/lib/platform/telemetry";

/**
 * The identity-to-database bridge (owned port of upstream `auth-user.ts`, over the session
 * port). Sign-in is the port's business; the user row, their memberships and the active
 * organization are created or refreshed lazily on the first database-backed request.
 *
 * Membership is many-to-many: a user can belong to several organizations, each with its own
 * role. `users.currentOrganizationId` remembers the one they are viewing. A brand-new user gets
 * a personal organization automatically, so the app always has an organization to scope to.
 *
 * Callers must check `isDbConfigured()` before invoking.
 */
export type SessionContext = {
  user: User;
  organization: Organization;
  role: OrgRole;
  memberships: MembershipView[];
};

type ResolvedSessionContext = SessionContext & { personalOrganizationCreated: boolean };

export type SessionDeps = {
  resolvePrincipal: () => Promise<Principal | null>;
  actingAs: () => Promise<ActingAs>;
  upsertUser: typeof upsertUserByExternalId;
  listMemberships: typeof listOrganizationsForUser;
  ensurePersonalOrganization: typeof ensurePersonalOrganization;
  setCurrentOrganization: typeof setCurrentOrganization;
  getOrganizationById: typeof getOrganizationById;
  getUserById: typeof getUserById;
  trackProductEvent: typeof trackProductEvent;
};

const defaultDeps = (): SessionDeps => ({
  resolvePrincipal: () => composition.session.resolvePrincipal(),
  actingAs: () => composition.session.actingAs(),
  upsertUser: upsertUserByExternalId,
  listMemberships: listOrganizationsForUser,
  ensurePersonalOrganization,
  setCurrentOrganization,
  getOrganizationById,
  getUserById,
  trackProductEvent,
});

/** Flatten the principal into the identity fields the `users` row stores. */
function identityFromPrincipal(principal: Principal) {
  return {
    externalId: principal.id,
    username: principal.username,
    email: principal.email,
    name: principal.name ?? principal.username ?? null,
    avatarUrl: principal.avatarUrl,
  };
}

/**
 * Resolve the signed-in user together with their active organization, role and membership
 * list. Null when there is no session. Upserts the user, and guarantees an active organization:
 * an empty membership set is healed by provisioning a personal organization, and a stale or
 * null active-organization pointer falls back to the first membership (persisted so it
 * self-heals). Exported for tests; pages use `getSessionContext`.
 */
export async function resolveSessionContext(
  deps: SessionDeps = defaultDeps(),
): Promise<ResolvedSessionContext | null> {
  const principal = await deps.resolvePrincipal();
  if (!principal) return null;

  const user = await deps.upsertUser(identityFromPrincipal(principal));
  const memberships = await deps.listMemberships(user.id);
  if (memberships.length === 0) {
    const base = slugify(user.username || user.name || "org") || "org";
    const name = user.name || user.username || "Personal organization";
    const { organization, role, created } = await deps.ensurePersonalOrganization({
      userId: user.id,
      preferredSlug: base,
      fallbackSlug: `${base}-${slugify(user.externalId) || user.id}`,
      name,
    });
    return {
      user: { ...user, currentOrganizationId: organization.id },
      organization,
      role,
      memberships: [{ organization, role }],
      personalOrganizationCreated: created,
    };
  }

  const pointed = memberships.find((m) => m.organization.id === user.currentOrganizationId);
  const active = pointed ?? memberships[0];
  if (!pointed) await deps.setCurrentOrganization(user.id, active.organization.id);

  return {
    user: pointed ? user : { ...user, currentOrganizationId: active.organization.id },
    organization: active.organization,
    role: active.role,
    memberships,
    personalOrganizationCreated: false,
  };
}

/**
 * The context inside an acting-as session (Cloud support): the operator's own row pinned to
 * the target organization, or the target user read as they are. Nothing is upserted or healed,
 * and no event is emitted.
 */
async function resolveActingAsContext(
  actingAs: NonNullable<ActingAs>,
  deps: SessionDeps,
): Promise<SessionContext | null> {
  if (actingAs.kind === "user") {
    const user = await deps.getUserById(actingAs.targetId);
    if (!user) return null;
    const memberships = await deps.listMemberships(user.id);
    const active =
      memberships.find((m) => m.organization.id === user.currentOrganizationId) ?? memberships[0];
    if (!active) return null;
    return { user, organization: active.organization, role: active.role, memberships };
  }
  const [own, organization] = await Promise.all([
    resolveSessionContext(deps),
    deps.getOrganizationById(actingAs.targetId),
  ]);
  if (!own || !organization) return null;
  return {
    user: own.user,
    organization,
    role: actingAs.readOnly ? "member" : "admin",
    memberships: own.memberships,
  };
}

export async function loadSessionContext(
  deps: SessionDeps = defaultDeps(),
): Promise<SessionContext | null> {
  const actingAs = await deps.actingAs();
  if (actingAs) return resolveActingAsContext(actingAs, deps);

  const resolved = await resolveSessionContext(deps);
  if (!resolved) return null;
  const { personalOrganizationCreated, ...context } = resolved;
  if (personalOrganizationCreated) {
    await deps.trackProductEvent(
      "organization_created",
      { externalId: context.user.externalId, orgId: context.organization.id },
      { org_slug: context.organization.slug, source: "personal" },
    );
  }
  return context;
}

/**
 * The session for this request, shared by every layout and page that renders it (React
 * `cache`). Demo-project seeding, which upstream did here, is the console's job
 * (`app/(app)/layout.tsx`), because it lives above this layer.
 */
export const getSessionContext = cache(
  async (): Promise<SessionContext | null> => loadSessionContext(),
);

/** Upstream kept a second resolver for flag evaluation; there are no flags here. */
export const getFlagSessionContext = getSessionContext;
