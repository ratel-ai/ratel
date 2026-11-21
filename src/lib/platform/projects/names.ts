/**
 * Project-level field constants shared by the Settings UI and its server action
 * (parallel to `lib/organization.ts`). Kept runtime-free so a client component can
 * import the limit without pulling in server code.
 */

export type NormalizedProjectName = { ok: true; name: string } | { ok: false; error: string };

export const PROJECT_NAME_MAX_LEN = 60;

export function normalizeProjectName(name: string): NormalizedProjectName {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Project name can't be empty." };
  if (trimmed.length > PROJECT_NAME_MAX_LEN) {
    return {
      ok: false,
      error: `Project name must be ${PROJECT_NAME_MAX_LEN} characters or fewer.`,
    };
  }
  return { ok: true, name: trimmed };
}

/** Resolve the URL-requested project, falling back to the first available one. */
export function selectActiveProject<T extends { slug: string }>(
  projects: readonly T[],
  requestedSlug: string | null | undefined,
): T | undefined {
  return projects.find((project) => project.slug === requestedSlug) ?? projects[0];
}
