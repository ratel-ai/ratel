import { lastProjectCookie, parseLastProjectCookie } from "@/lib/console/scope/cookie";

/**
 * Remembering the project a reader is in. Upstream's proxy writes the last-project cookie as it
 * serves a project page; this edition has no proxy (ADR-0003) and a layout cannot set a cookie,
 * so the project layout renders a client component that calls a server action, and the action
 * calls this. Upstream's rule is kept: the cookie is written only when it changes, because a
 * cookie set in a server action makes Next render the page again.
 */

export type RememberProjectDeps = {
  /** The cookie's value on this request. */
  current(): Promise<string | null | undefined>;
  /** The project as this session may see it, or null. */
  resolveProjectScope(projectId: string): Promise<unknown | null>;
  write(cookie: ReturnType<typeof lastProjectCookie>): void;
  secure: boolean;
};

/** Whether the cookie names another project than the open one, or none. */
export function lastProjectDiffers(
  cookieValue: string | null | undefined,
  projectId: string,
): boolean {
  const open = parseLastProjectCookie(projectId);
  return open !== null && parseLastProjectCookie(cookieValue) !== open;
}

/** Writes the cookie for a project this session may see, when it differs; says whether it wrote. */
export async function rememberLastProject(
  projectId: string,
  deps: RememberProjectDeps,
): Promise<boolean> {
  const open = parseLastProjectCookie(projectId);
  if (!open) return false;
  if (!lastProjectDiffers(await deps.current(), open)) return false;
  if (!(await deps.resolveProjectScope(open))) return false;
  deps.write(lastProjectCookie(open, deps.secure));
  return true;
}

export type OpenProjectDeps<S> = {
  /** The project as this reader may see it (`findProjectScope`), or null. */
  find(projectId: string): Promise<S | null>;
  /** The edition's memory of the last project (`SessionPort.rememberProject`); absent in open source. */
  remember?(projectId: string): Promise<void>;
};

/**
 * What the project layout does when a project is opened: the scope check, then, only for a project
 * the reader may see, the edition's last-project pointer. Upstream's project layout writes
 * `users.last_project_id` the same way, after `getProjectScope` (`setLastProject`).
 */
export async function openProject<S extends { project: { id: string } }>(
  projectId: string,
  deps: OpenProjectDeps<S>,
): Promise<S | null> {
  const scope = await deps.find(projectId);
  if (!scope) return null;
  await deps.remember?.(scope.project.id);
  return scope;
}
