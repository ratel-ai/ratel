import { projectRoot } from "@/lib/console/navigation";
import { formatDay, formatStamp } from "@/lib/console/settings/format";
import type { ProjectCapacity } from "@/lib/platform/projects/capacity";

/** Where the Projects page keeps its search in the URL, so a reload keeps it. */
export const PROJECT_SEARCH_PARAM = "q";

/** The organization's projects as the Projects page lists them. */
export interface ProjectListItem {
  id: string;
  name: string;
  slug: string;
  isDemo: boolean;
  href: string;
  created: string;
  createdTitle: string;
}

export function projectListItems(
  projects: ReadonlyArray<{
    id: string;
    name: string;
    slug: string;
    isDemo?: boolean | null;
    createdAt: Date;
  }>,
): ProjectListItem[] {
  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    slug: project.slug,
    isDemo: Boolean(project.isDemo),
    href: projectRoot(project.id),
    created: formatDay(project.createdAt),
    createdTitle: formatStamp(project.createdAt),
  }));
}

/** Case- and accent-insensitive match on the name or the slug. Blank keeps every project. */
export function filterProjects<T extends { name: string; slug: string }>(
  projects: readonly T[],
  query: string,
): T[] {
  const needle = fold(query.trim());
  if (!needle) return [...projects];
  return projects.filter(
    (project) => fold(project.name).includes(needle) || fold(project.slug).includes(needle),
  );
}

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** "2 of 3 projects", "4 of unlimited projects": the plan's room, next to the list. */
export function projectUsageLabel(capacity: Pick<ProjectCapacity, "used" | "limit">): string {
  const limit = Number.isFinite(capacity.limit) ? String(capacity.limit) : "unlimited";
  return `${capacity.used} of ${limit} ${capacity.limit === 1 ? "project" : "projects"}`;
}
