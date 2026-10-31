import { getMembership, getOrganizationById } from "@/lib/platform/identity/queries";
import type { Organization } from "@/lib/platform/identity/schema";
import { getProjectById } from "@/lib/platform/projects/queries";
import type { Project } from "@/lib/platform/projects/schema";
import { getSessionContext } from "@/lib/platform/session";

/**
 * Session-authenticated project resolution by id (membership, not the active
 * organization pointer). Owned extract of the upstream catalog/http helper so
 * the runtime-catalog override PATCH path does not import the console-bound
 * http module.
 */

export type ResolvedProject =
  | {
      ok: true;
      accountId: string;
      externalId: string;
      organization: Organization;
      project: Project;
    }
  | { ok: false; response: Response };

export async function resolveProjectById(projectId: string | null): Promise<ResolvedProject> {
  const ctx = await getSessionContext();
  if (!ctx) {
    return { ok: false, response: Response.json({ error: "Not authenticated." }, { status: 401 }) };
  }
  if (!projectId) {
    return { ok: false, response: Response.json({ error: "Missing project." }, { status: 400 }) };
  }
  const project = await getProjectById(projectId);
  if (!project) {
    return { ok: false, response: Response.json({ error: "Project not found." }, { status: 404 }) };
  }
  const membership = await getMembership(ctx.user.id, project.organizationId);
  if (!membership) {
    return { ok: false, response: Response.json({ error: "Project not found." }, { status: 404 }) };
  }
  const organization =
    project.organizationId === ctx.organization.id
      ? ctx.organization
      : await getOrganizationById(project.organizationId);
  if (!organization) {
    return { ok: false, response: Response.json({ error: "Project not found." }, { status: 404 }) };
  }
  return {
    ok: true,
    accountId: organization.id,
    externalId: ctx.user.externalId,
    organization,
    project,
  };
}
