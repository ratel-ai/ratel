import { notFound } from "next/navigation";
import { cache } from "react";
import type { Session, SessionUser } from "@/lib/contracts/session";
import type { Organization } from "@/lib/platform/organizations";
import { getProjectById, parseProjectUuid } from "@/lib/platform/projects/queries";
import type { Project } from "@/lib/platform/projects/schema";
import { getSessionContext, membershipIn } from "@/lib/platform/session";

/**
 * The reader's view of one project: the project, the organization it belongs to and the
 * reader's role in it. Pages and API routes read it through one function each, so the rule is
 * written once: upstream's (`resolvers.ts`, `resolveProjectScopeOrNull`), the project's own
 * organization, authorized by the reader's membership in it. The active organization is neither
 * consulted nor changed, so a link into any organization the reader belongs to opens. Same return
 * shape as upstream's project scope, so copied call sites read `organization` and `project`
 * unchanged.
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
  user: SessionUser;
}

/**
 * The rule, given the session and the project read: null when the id is not a project id, there
 * is no such project, or the reader is not a member of its organization.
 */
export async function resolveProjectScope(
  projectId: string,
  session: Session,
  getProject: (id: string) => Promise<Project | null>,
): Promise<ProjectScope | null> {
  const id = parseProjectUuid(projectId);
  if (!id) return null;
  const project = await getProject(id);
  if (!project) return null;
  const membership = membershipIn(session, project.organizationId);
  if (!membership) return null;
  return {
    project,
    organization: membership.organization,
    role: membership.role,
    user: session.user,
  };
}

/** Null when nobody is signed in, or under `resolveProjectScope`'s rule. */
export const findProjectScope = cache(async (projectId: string): Promise<ProjectScope | null> => {
  const session = await getSessionContext();
  if (!session) return null;
  return resolveProjectScope(projectId, session, (id) => getProjectById(id));
});

/** What a page calls: the scope, or a 404. */
export async function requireProjectScope(projectId: string): Promise<ProjectScope> {
  const scope = await findProjectScope(projectId);
  if (!scope) notFound();
  return scope;
}

/** Upstream's name for the same read, kept so copied call sites stay identical. */
export const getProjectScope = requireProjectScope;
