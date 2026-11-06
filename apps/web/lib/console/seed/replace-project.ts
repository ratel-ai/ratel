import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { LOCAL_ORGANIZATION_ID } from "@/lib/adapters/oss/session";
import { composition } from "@/lib/composition/ports";
import type { getDb } from "@/lib/platform/db/client";
import type { Organization } from "@/lib/platform/organizations";
import { projects } from "@/lib/platform/projects/schema";

/**
 * Helpers the local data scripts share (`scripts/seed.mts`): find the
 * organization to write into, and replace a project wholesale so a rerun
 * starts from nothing.
 */

type Db = ReturnType<typeof getDb>;

/**
 * The organization named by id, through the session port; by default the open-source
 * operator's. Throws when the edition does not know it (in Cloud, pass one).
 */
export async function resolveSeedOrganization(
  id: string = LOCAL_ORGANIZATION_ID,
  getOrganization: (id: string) => Promise<Organization | null> = (orgId) =>
    composition.session.getOrganization(orgId),
): Promise<Organization> {
  const organization = await getOrganization(id);
  if (!organization) throw new Error(`no organization "${id}"; pass an organization id`);
  return organization;
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
