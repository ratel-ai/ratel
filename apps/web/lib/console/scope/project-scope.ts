import { notFound } from "next/navigation";
import { cache } from "react";
import type { Organization, User } from "@/lib/platform/identity/schema";
import { getProjectById, parseProjectUuid } from "@/lib/platform/projects/queries";
import type { Project } from "@/lib/platform/projects/schema";
import { getSessionContext } from "@/lib/platform/session";

/**
 * The reader's view of one project: the project, the organization it belongs to and the
 * reader's role in it. Pages and API routes read it through one function each, so the rule
 * (the project is the session organization's, or it does not exist) is written once. Same
 * return shape as upstream's project scope, so copied call sites read `organization` and
 * `project` unchanged.
 */

export type OrgRole =
  Awaited<ReturnType<typeof getSessionContext>> extends infer S
    ? S extends { role: infer R }
      ? R
      : never
    : never;

export interface ProjectScope {
  project: Project;
  organization: Organization;
  role: OrgRole;
  user: User;
}

/** Null when nobody is signed in, the id is not a project id, or the project is another organization's. */
export const findProjectScope = cache(async (projectId: string): Promise<ProjectScope | null> => {
  const session = await getSessionContext();
  if (!session) return null;
  const id = parseProjectUuid(projectId);
  if (!id) return null;
  const project = await getProjectById(id);
  if (!project || project.organizationId !== session.organization.id) return null;
  return { project, organization: session.organization, role: session.role, user: session.user };
});

/** What a page calls: the scope, or a 404. */
export async function requireProjectScope(projectId: string): Promise<ProjectScope> {
  const scope = await findProjectScope(projectId);
  if (!scope) notFound();
  return scope;
}

/** Upstream's name for the same read, kept so copied call sites stay identical. */
export const getProjectScope = requireProjectScope;
