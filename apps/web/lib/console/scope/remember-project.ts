import { lastProjectCookie, parseLastProjectCookie } from "@/lib/console/scope/cookie";

/**
 * Remembering the project a reader is in. Upstream's proxy writes the last-project cookie as it
 * serves a project page; this edition has no proxy (ADR-0029) and a layout cannot set a cookie,
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
