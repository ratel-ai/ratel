import { parseProjectUuid } from "@/lib/console/scope/cookie";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { listProjectsForOrganization } from "@/lib/platform/projects/queries";
import { getSessionContext } from "@/lib/platform/session";

/**
 * The last project a reader was in. Owned (ADR-0030): upstream also keeps a pointer on the
 * users row; identity is the edition's here, so the memory is the cookie, checked against the
 * session organization's projects, and the stored pointer is the organization's first project,
 * so an old link always lands somewhere live.
 */

export type LastProjectResolverDeps = {
  getLastProjectId(userId: string): Promise<string | null>;
  resolveProjectScope(projectId: string, userId: string): Promise<unknown | null>;
};

async function firstProjectId(): Promise<string | null> {
  const session = await getSessionContext();
  if (!session) return null;
  const [first] = await listProjectsForOrganization(session.organization.id);
  return first?.id ?? null;
}

const DEFAULT_LAST_PROJECT_RESOLVER_DEPS: LastProjectResolverDeps = {
  getLastProjectId: firstProjectId,
  resolveProjectScope: (projectId) => findProjectScope(projectId),
};

export async function signedInLandingDestination(
  lastProjectCookie: string | null | undefined,
  userId: string,
  deps: LastProjectResolverDeps = DEFAULT_LAST_PROJECT_RESOLVER_DEPS,
): Promise<string> {
  const projectId = await resolveLastProjectId(userId, lastProjectCookie, deps);
  return projectId ? `/project/${projectId}` : "/organizations";
}

export async function resolveLastProjectId(
  userId: string,
  lastProjectCookie: string | null | undefined,
  deps: LastProjectResolverDeps = DEFAULT_LAST_PROJECT_RESOLVER_DEPS,
): Promise<string | null> {
  const cookieProjectId = parseProjectUuid(lastProjectCookie);
  if (cookieProjectId && (await deps.resolveProjectScope(cookieProjectId, userId))) {
    return cookieProjectId;
  }

  const storedProjectId = parseProjectUuid(await deps.getLastProjectId(userId));
  if (
    storedProjectId &&
    storedProjectId !== cookieProjectId &&
    (await deps.resolveProjectScope(storedProjectId, userId))
  ) {
    return storedProjectId;
  }

  return null;
}
