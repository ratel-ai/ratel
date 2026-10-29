import type { NavItem as EditionNavItem } from "@/lib/composition/ports";

/**
 * The console navigation (DESIGN.md, Information architecture). Pure functions of the URL and the
 * composition, so the rail and the tests read one model. Only destinations this build has are
 * listed: a page that has not landed is absent, never disabled.
 */

export type NavIconName = "overview" | "edition";

export interface NavItem {
  /** Stable across renders and projects: core ids are fixed, edition ids derive from the href. */
  id: string;
  label: string;
  href: string;
  icon: NavIconName;
  /** The item is the current page only on this exact path (index pages). */
  exact?: boolean;
}

const PROJECT_ROUTE = /^\/project\/([^/?#]+)/;

export function projectRoot(projectId: string): string {
  return `/project/${encodeURIComponent(projectId)}`;
}

export function projectIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(PROJECT_ROUTE);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** Core destinations of one project, then whatever the edition adds (`composition.nav`). */
export function consoleNav({
  projectId,
  additions,
}: {
  projectId: string | undefined;
  additions: readonly EditionNavItem[];
}): NavItem[] {
  const core: NavItem[] = projectId
    ? [
        {
          id: "overview",
          label: "Overview",
          href: projectRoot(projectId),
          icon: "overview",
          exact: true,
        },
      ]
    : [];
  return [
    ...core,
    ...additions.map((item) => ({
      id: `edition:${item.href}`,
      label: item.label,
      href: item.href,
      icon: "edition" as const,
    })),
  ];
}

function matches(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The item for this path; the longest matching href wins. */
export function activeNavItemId(pathname: string, items: readonly NavItem[]): string | null {
  let best: NavItem | null = null;
  for (const item of items) {
    const hit = item.exact ? pathname === item.href : matches(pathname, item.href);
    if (hit && (!best || item.href.length >= best.href.length)) best = item;
  }
  return best?.id ?? null;
}

/** The same section in another project; outside a project, that project's root. */
export function switchProjectHref(path: string, projectId: string): string {
  return PROJECT_ROUTE.test(path)
    ? path.replace(PROJECT_ROUTE, projectRoot(projectId))
    : projectRoot(projectId);
}

/** A project of the organization's list, or nothing: a route never trusts the id in its URL. */
export function findProject<T extends { id: string }>(
  projects: readonly T[],
  id: string | undefined,
): T | undefined {
  return id ? projects.find((project) => project.id === id) : undefined;
}

/** Where the console opens: the first project, or null for the first-run state. */
export function entryHref(projects: readonly { id: string }[]): string | null {
  return projects[0] ? projectRoot(projects[0].id) : null;
}
