import { billableProjectCount, checkQuota, type OrgLimitView } from "@/lib/platform/entitlements";
import { slugify } from "@/lib/platform/organization";
import { normalizeProjectName } from "@/lib/platform/projects/names";

export type CreateProjectResult = { ok: true; projectId: string } | { ok: false; error: string };

export type CreateProjectDeps = {
  /** The session organization; null without a session. */
  organization: () => Promise<(OrgLimitView & { slug: string }) | null>;
  listProjects: (organizationId: string) => Promise<{ slug: string; isDemo?: boolean | null }[]>;
  createProject: (input: { organizationId: string; name: string; slug: string }) => Promise<{
    id: string;
  }>;
};

/** The name's slug, suffixed `-2`, `-3`… past the ones the organization already uses. */
export function uniqueProjectSlug(name: string, taken: readonly string[]): string {
  const base = slugify(name) || "project";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Creates a project in the session organization: the slug in the URL must be that
 * organization's, and the plan's project cap (the demo project aside) must have room.
 */
export async function createConsoleProject(
  organizationSlug: string,
  name: string,
  deps: CreateProjectDeps,
): Promise<CreateProjectResult> {
  const organization = await deps.organization();
  if (!organization || organization.slug !== organizationSlug) {
    return { ok: false, error: "Organization not found." };
  }
  const normalized = normalizeProjectName(name);
  if (!normalized.ok) return normalized;
  const projects = await deps.listProjects(organization.id);
  const quota = checkQuota(organization, "maxProjects", billableProjectCount(projects));
  if (!quota.ok) return { ok: false, error: quota.message };
  const project = await deps.createProject({
    organizationId: organization.id,
    name: normalized.name,
    slug: uniqueProjectSlug(
      normalized.name,
      projects.map((p) => p.slug),
    ),
  });
  return { ok: true, projectId: project.id };
}
