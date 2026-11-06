const PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const LAST_PROJECT_COOKIE = "ratel_last_project";

export function lastProjectCookie(projectId: string, secure: boolean) {
  const value = parseLastProjectCookie(projectId);
  if (!value) throw new TypeError("project id must be a canonical UUID");

  return {
    name: LAST_PROJECT_COOKIE,
    value,
    options: {
      httpOnly: true,
      maxAge: 31_536_000,
      path: "/",
      sameSite: "lax" as const,
      secure,
    },
  };
}

export function projectIdFromScopedPath(pathname: string): string | null {
  const [, scope, projectId] = pathname.split("/");
  return scope === "project" ? parseLastProjectCookie(projectId) : null;
}

export function parseLastProjectCookie(value: string | null | undefined): string | null {
  return parseProjectUuid(value);
}

export function parseProjectUuid(value: string | null | undefined): string | null {
  return value && PROJECT_UUID.test(value) ? value.toLowerCase() : null;
}
