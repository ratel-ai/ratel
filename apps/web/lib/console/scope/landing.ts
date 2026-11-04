import { parseProjectUuid } from "@/lib/console/scope/cookie";
import { findProjectScope } from "@/lib/console/scope/project-scope";

/**
 * The last project a reader was in. Owned (ADR-0030): upstream also keeps a pointer on the
 * users row; identity is the edition's here, so the cookie is the only memory, checked against
 * the session organization's projects.
 */

export type LastProjectResolverDeps = {
  getLastProjectId(userId: string): Promise<string | null>;
  resolveProjectScope(projectId: string, userId: string): Promise<unknown | null>;
};

const DEFAULT_LAST_PROJECT_RESOLVER_DEPS: LastProjectResolverDeps = {
  getLastProjectId: async () => null,
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
