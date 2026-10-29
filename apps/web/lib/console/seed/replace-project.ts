import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import { memberships, organizations } from "@/lib/platform/identity/schema";
import { projects } from "@/lib/platform/projects/schema";

/**
 * Helpers the local data scripts share (`scripts/seed.mts`): find the
 * organization to write into, and replace a project wholesale so a rerun
 * starts from nothing.
 */

type Db = ReturnType<typeof getDb>;

/** The workspace `DEV_AUTH_BYPASS=1` signs in to. */
export const LOCAL_DEV_ORG_SLUG = "local-dev";

export interface SeedOrganization {
  id: string;
  slug: string;
}

/**
 * The organization named by `slug`; else `local-dev`; else the only
 * organization with a member. Throws when none of those settles it.
 */
export async function resolveSeedOrganization(db: Db, slug?: string): Promise<SeedOrganization> {
  const columns = { id: organizations.id, slug: organizations.slug };
  const bySlug = async (value: string) =>
    (await db.select(columns).from(organizations).where(eq(organizations.slug, value)).limit(1))[0];
  if (slug) {
    const named = await bySlug(slug);
    if (!named) throw new Error(`no organization with slug "${slug}"`);
    return named;
  }
  const local = await bySlug(LOCAL_DEV_ORG_SLUG);
  if (local) return local;
  const withMembers = await db
    .selectDistinct(columns)
    .from(organizations)
    .innerJoin(memberships, eq(memberships.organizationId, organizations.id));
  const only = withMembers.length === 1 ? withMembers[0] : undefined;
  if (only) return only;
  if (withMembers.length === 0) {
    throw new Error("No organization has a member yet. Sign in to the console first, then rerun.");
  }
  throw new Error(
    `Several organizations have members and none is ${LOCAL_DEV_ORG_SLUG}; pass one: ${withMembers.map((o) => o.slug).join(", ")}`,
  );
}

/** A project id that is the same on every run for one organization and slug (UUID layout, version 8). */
export function stableProjectId(organizationId: string, slug: string): string {
  const hex = createHash("sha256")
    .update(`project:${organizationId}:${slug}`, "utf8")
    .digest("hex");
  const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface ReplacedProject {
  id: string;
  /** Whether an earlier copy was deleted first. */
  replaced: boolean;
}

/**
 * Delete the organization's project with this slug, if any, with everything
 * it owns (every table cascades from `projects`), and create it again under
 * the same id, so links into it keep working across reruns.
 */
export async function replaceProject(
  db: Db,
  input: { organizationId: string; slug: string; name: string; isDemo: boolean },
): Promise<ReplacedProject> {
  const [existing] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.organizationId, input.organizationId), eq(projects.slug, input.slug)))
    .limit(1);
  const id = existing?.id ?? stableProjectId(input.organizationId, input.slug);
  await db.transaction(async (tx) => {
    await tx.delete(projects).where(eq(projects.id, id));
    await tx.insert(projects).values({
      id,
      organizationId: input.organizationId,
      name: input.name,
      slug: input.slug,
      isDemo: input.isDemo,
    });
  });
  return { id, replaced: existing !== undefined };
}
