import { and, asc, desc, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import { cache } from "react";
import { getDb } from "@/lib/platform/db/client";
import { isUniqueViolation } from "@/lib/platform/db/errors";
import {
  type Membership,
  memberships,
  type NewOrganization,
  type Organization,
  organizations,
  type User,
  users,
} from "@/lib/platform/identity/schema";
import { type OrgRole, toRole } from "@/lib/platform/organization";
import { projects } from "@/lib/platform/projects/schema";

/**
 * Users, memberships and organizations (owned port of the upstream query hub, without the
 * billing, invitation and credit functions, which belong to the private edition).
 */

export type SettingsDb = Pick<ReturnType<typeof getDb>, "update">;
export type UpdateOrganizationSettingsResult =
  | { ok: true }
  | { ok: false; reason: "slug_conflict" };
export type LastProjectDb = Pick<ReturnType<typeof getDb>, "select" | "update">;
export type LookupDb = Pick<ReturnType<typeof getDb>, "select">;

/* Users */

/** Insert or update a user by the identity provider's id (called lazily on the first DB request). */
export async function upsertUserByExternalId(input: {
  externalId: string;
  username?: string | null;
  email?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
}): Promise<User> {
  // Only overwrite identity fields we actually received; never clobber a stored username with
  // null when a later session omits the profile.
  const set: Partial<typeof users.$inferInsert> = {
    email: input.email ?? null,
    name: input.name ?? null,
    avatarUrl: input.avatarUrl ?? null,
  };
  if (input.username) set.username = input.username;

  const [row] = await getDb()
    .insert(users)
    .values({ externalId: input.externalId, ...set })
    .onConflictDoUpdate({ target: users.externalId, set })
    .returning();
  return row;
}

export async function getUserById(id: string): Promise<User | null> {
  const [row] = await getDb().select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

/** Read-only lookup by the provider's id: never provisions anything. */
export async function getUserByExternalId(externalId: string): Promise<User | null> {
  const [row] = await getDb().select().from(users).where(eq(users.externalId, externalId)).limit(1);
  return row ?? null;
}

/** Look up a user by email (case-insensitive); email is not unique, so the first match. */
export async function getUserByEmail(email: string, db: LookupDb = getDb()): Promise<User | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
    .limit(1);
  return row ?? null;
}

/** Persist a validated project visit, avoiding an update when already current. */
export async function setLastProject(
  userId: string,
  projectId: string,
  db: LastProjectDb = getDb(),
): Promise<void> {
  await db
    .update(users)
    .set({ lastProjectId: projectId })
    .where(and(eq(users.id, userId), sql`${users.lastProjectId} is distinct from ${projectId}`));
}

/** A user's persisted last-project pointer, or null. */
export async function getLastProjectId(
  userId: string,
  db: LastProjectDb = getDb(),
): Promise<string | null> {
  const [row] = await db
    .select({ lastProjectId: users.lastProjectId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.lastProjectId ?? null;
}

/** Record how the user left the guided tour; the console validates on read. */
export async function setOnboardingTourStatus(
  userId: string,
  status: string,
  db: SettingsDb = getDb(),
): Promise<void> {
  await db.update(users).set({ onboardingTourStatus: status }).where(eq(users.id, userId));
}

/**
 * Claim the right to seed this organization's demo project, exactly once: a conditional UPDATE,
 * so concurrent first renders cannot both seed. The watermark is set before the seed runs, so a
 * failed seed is not retried on every page load.
 */
export async function claimDemoProjectSeeding(
  organizationId: string,
  at: Date,
  db: SettingsDb = getDb(),
): Promise<boolean> {
  const claimed = await db
    .update(organizations)
    .set({ demoProjectSeededAt: at })
    .where(and(eq(organizations.id, organizationId), isNull(organizations.demoProjectSeededAt)))
    .returning({ id: organizations.id });
  return claimed.length > 0;
}

/* Memberships */

export type OrganizationMember = { user: User; role: OrgRole };
export type MembershipView = { organization: Organization; role: OrgRole };

/** Add (or re-grant) a membership. Idempotent on (user, organization). */
export async function addMembership(
  userId: string,
  organizationId: string,
  role: OrgRole,
): Promise<Membership> {
  const [row] = await getDb()
    .insert(memberships)
    .values({ userId, organizationId, role })
    .onConflictDoUpdate({ target: [memberships.userId, memberships.organizationId], set: { role } })
    .returning();
  return row;
}

export async function removeMembership(userId: string, organizationId: string): Promise<void> {
  await getDb()
    .delete(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, organizationId)));
}

export async function updateMembershipRole(
  userId: string,
  organizationId: string,
  role: OrgRole,
): Promise<void> {
  await getDb()
    .update(memberships)
    .set({ role })
    .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, organizationId)));
}

/** The (user, organization) membership row, or null if the user is not a member. */
export async function getMembership(
  userId: string,
  organizationId: string,
): Promise<Membership | null> {
  const [row] = await getDb()
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

/** How many admins an organization has (guards demoting or removing the last one). */
export async function countOrganizationAdmins(organizationId: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.role, "admin")));
  return row?.n ?? 0;
}

export async function countMemberships(organizationId: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(eq(memberships.organizationId, organizationId));
  return row?.n ?? 0;
}

/** An organization's members with their role, admins first then oldest membership. */
export async function listOrganizationMembersWithRole(
  organizationId: string,
): Promise<OrganizationMember[]> {
  const rows = await getDb()
    .select({ user: users, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.organizationId, organizationId))
    .orderBy(desc(eq(memberships.role, "admin")), asc(memberships.createdAt));
  return rows.map((r) => ({ user: r.user, role: toRole(r.role) }));
}

/** Every organization a user belongs to, with their role, oldest membership first. */
export async function listOrganizationsForUser(userId: string): Promise<MembershipView[]> {
  const rows = await getDb()
    .select({ organization: organizations, role: memberships.role })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.createdAt));
  return rows.map((r) => ({ organization: r.organization, role: toRole(r.role) }));
}

/** Point a user's active-organization pointer at an organization. */
export async function setCurrentOrganization(
  userId: string,
  organizationId: string,
): Promise<void> {
  await getDb()
    .update(users)
    .set({ currentOrganizationId: organizationId })
    .where(eq(users.id, userId));
}

export async function clearCurrentOrganization(userId: string): Promise<void> {
  await getDb().update(users).set({ currentOrganizationId: null }).where(eq(users.id, userId));
}

/* Organizations */

export async function createOrganization(input: NewOrganization): Promise<Organization> {
  const [row] = await getDb().insert(organizations).values(input).returning();
  return row;
}

export type OrganizationsDb = Pick<ReturnType<typeof getDb>, "transaction">;

/**
 * Atomically ensure a user has a personal organization, returning it with their role. Safe under
 * concurrency: the first render fans out to several server components at once, and a fresh user
 * would otherwise have each of them race to INSERT the same organization. A transaction-scoped
 * advisory lock keyed on the slug serializes the racers; the membership re-check inside the lock
 * lets late arrivals reuse the organization the winner created; the slug-taken check hands a
 * different user who shares the friendly slug the per-user-unique fallback.
 */
export async function ensurePersonalOrganization(
  params: { userId: string; preferredSlug: string; fallbackSlug: string; name: string },
  db: OrganizationsDb = getDb(),
): Promise<MembershipView & { created: boolean }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${params.preferredSlug})::bigint)`);

    const [existing] = await tx
      .select({ organization: organizations, role: memberships.role })
      .from(memberships)
      .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
      .where(eq(memberships.userId, params.userId))
      .orderBy(asc(memberships.createdAt))
      .limit(1);
    if (existing) {
      return { organization: existing.organization, role: toRole(existing.role), created: false };
    }

    const [taken] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, params.preferredSlug))
      .limit(1);
    const slug = taken ? params.fallbackSlug : params.preferredSlug;

    const [organization] = await tx
      .insert(organizations)
      .values({ name: params.name, slug })
      .returning();
    await tx
      .insert(memberships)
      .values({ userId: params.userId, organizationId: organization.id, role: "admin" })
      .onConflictDoUpdate({
        target: [memberships.userId, memberships.organizationId],
        set: { role: "admin" },
      });
    await tx
      .update(users)
      .set({ currentOrganizationId: organization.id })
      .where(eq(users.id, params.userId));

    return { organization, role: "admin", created: true };
  });
}

export const getOrganizationById = cache(async function getOrganizationById(
  id: string,
): Promise<Organization | null> {
  const [row] = await getDb().select().from(organizations).where(eq(organizations.id, id)).limit(1);
  return row ?? null;
});

/** Resolve a globally unique organization slug for path-scoped navigation. */
export async function getOrganizationBySlug(slug: string): Promise<Organization | null> {
  const [row] = await getDb()
    .select()
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1);
  return row ?? null;
}

/** The organization that owns a project, resolved from a project id (API-key surfaces). */
export async function getOrganizationByProjectId(projectId: string): Promise<Organization | null> {
  const [row] = await getDb()
    .select(getTableColumns(organizations))
    .from(organizations)
    .innerJoin(projects, eq(projects.organizationId, organizations.id))
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ?? null;
}

export async function organizationSlugExists(slug: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1);
  return !!row;
}

/** Update an organization's editable settings in one write. */
export async function updateOrganizationSettings(
  organizationId: string,
  values: { name: string; slug: string },
  db: SettingsDb = getDb(),
): Promise<UpdateOrganizationSettingsResult> {
  try {
    await db.update(organizations).set(values).where(eq(organizations.id, organizationId));
    return { ok: true };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "slug_conflict" };
    throw err;
  }
}

export async function updateOrganizationName(organizationId: string, name: string): Promise<void> {
  await getDb().update(organizations).set({ name }).where(eq(organizations.id, organizationId));
}

/** Permanently delete an organization; projects and memberships cascade. */
export async function deleteOrganization(organizationId: string): Promise<void> {
  await getDb().delete(organizations).where(eq(organizations.id, organizationId));
}
