import type { NavItem as EditionNavItem } from "@/lib/composition/ports";

/**
 * The console navigation (DESIGN.md, Information architecture). Pure functions of the URL and the
 * composition, so the rail and the tests read one model. Only destinations this build has are
 * listed: a page that has not landed is absent, never disabled.
 */

export type NavIconName =
  | "overview"
  | "health"
  | "intents"
  | "improvements"
  | "catalog"
  | "traces"
  | "settings"
  | "projects"
  | "edition";

export interface NavItem {
  /** Stable across renders and projects: core ids are fixed, edition ids derive from the href. */
  id: string;
  label: string;
  href: string;
  icon: NavIconName;
  /** The item is the current page only on this exact path (index pages). */
  exact?: boolean;
  /** The key after `g` that jumps here. */
  shortcut?: string;
  /** The rail section it sits in; the rail leaves a gap between sections. Absent means `main`. */
  section?: "settings" | "edition";
  /** Sub-pages folded under this item; its own href is the group's landing page. */
  children?: readonly NavItem[];
}

/** Every item, children included, in rail order. */
export function flattenNav(items: readonly NavItem[]): NavItem[] {
  return items.flatMap((item) => [item, ...(item.children ?? [])]);
}

const PROJECT_ROUTE = /^\/project\/([^/?#]+)/;
const ORGANIZATION_ROUTE = /^\/org\/([^/?#]+)/;

export function projectRoot(projectId: string): string {
  return `/project/${encodeURIComponent(projectId)}`;
}

export function organizationRoot(slug: string): string {
  return `/org/${encodeURIComponent(slug)}`;
}

function segment(pathname: string, route: RegExp): string | undefined {
  const match = pathname.match(route);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function projectIdFromPath(pathname: string): string | undefined {
  return segment(pathname, PROJECT_ROUTE);
}

export function organizationSlugFromPath(pathname: string): string | undefined {
  return segment(pathname, ORGANIZATION_ROUTE);
}

/**
 * The rail: a project's destinations inside a project, the organization's outside one, then
 * whatever the edition adds (`composition.nav`).
 */
export function consoleNav({
  projectId,
  organizationSlug,
  additions,
}: {
  projectId: string | undefined;
  organizationSlug?: string;
  additions: readonly EditionNavItem[];
}): NavItem[] {
  const root = projectId ? projectRoot(projectId) : null;
  const organization: NavItem[] = organizationSlug
    ? [
        {
          id: "projects",
          label: "Projects",
          href: organizationRoot(organizationSlug),
          icon: "projects",
          exact: true,
          shortcut: "o",
        },
        {
          id: "org-settings",
          label: "Settings",
          href: `${organizationRoot(organizationSlug)}/settings`,
          icon: "settings",
          shortcut: "s",
          section: "settings",
        },
      ]
    : [];
  const core: NavItem[] = root
    ? [
        {
          id: "overview",
          label: "Overview",
          href: root,
          icon: "overview",
          exact: true,
          shortcut: "o",
        },
        {
          id: "health",
          label: "Agent health",
          href: `${root}/health`,
          icon: "health",
          exact: true,
          shortcut: "h",
          children: [
            {
              id: "health-summary",
              label: "Summary",
              href: `${root}/health`,
              icon: "health",
              exact: true,
            },
            { id: "health-tasks", label: "Tasks", href: `${root}/health/tasks`, icon: "health" },
            {
              id: "health-self-corrections",
              label: "Self-corrections",
              href: `${root}/health/self-corrections`,
              icon: "health",
            },
          ],
        },
        { id: "traces", label: "Traces", href: `${root}/traces`, icon: "traces", shortcut: "t" },
        {
          id: "catalog",
          label: "Catalog",
          href: `${root}/catalogs`,
          icon: "catalog",
          exact: true,
          shortcut: "c",
          children: [
            {
              id: "catalog-tools",
              label: "Tools",
              href: `${root}/catalogs/tools`,
              icon: "catalog",
            },
            {
              id: "catalog-skills",
              label: "Skills",
              href: `${root}/catalogs/skills`,
              icon: "catalog",
            },
            {
              id: "catalog-test",
              label: "Test a search",
              href: `${root}/playground`,
              icon: "catalog",
            },
          ],
        },
        {
          id: "intents",
          label: "Intents",
          href: `${root}/intents`,
          icon: "intents",
          exact: true,
          shortcut: "i",
          children: [
            {
              id: "intents-topics",
              label: "All intents",
              href: `${root}/intents`,
              icon: "intents",
              exact: true,
            },
            { id: "intents-flows", label: "Flows", href: `${root}/intents/flows`, icon: "intents" },
            { id: "intents-map", label: "Map", href: `${root}/intents/map`, icon: "intents" },
          ],
        },
        {
          id: "improvements",
          label: "Improvements",
          href: `${root}/improvement`,
          icon: "improvements",
          exact: true,
          children: [
            {
              id: "fixes",
              label: "Fixes",
              href: `${root}/improvement/fixes`,
              icon: "improvements",
              shortcut: "f",
            },
          ],
        },
        {
          id: "settings",
          label: "Settings",
          href: `${root}/settings`,
          icon: "settings",
          shortcut: "s",
          section: "settings",
        },
      ]
    : organization;
  return [
    ...core,
    ...additions.map((item) => ({
      id: `edition:${item.href}`,
      label: item.label,
      href: item.href,
      icon: "edition" as const,
      section: "edition" as const,
    })),
  ];
}

export type CommandEntry = { id: string; label: string; group: string; href: string };

/** What ⌘K searches: the rail's destinations, every project at the section being read, the projects page. */
export function commandEntries({
  items,
  projects,
  pathname,
  organizationSlug,
}: {
  items: readonly NavItem[];
  projects: readonly { id: string; name: string }[];
  pathname: string;
  organizationSlug?: string;
}): CommandEntry[] {
  const root = organizationSlug ? organizationRoot(organizationSlug) : null;
  return [
    ...flattenNav(items).map(({ id, label, href }) => ({
      id: `page:${id}`,
      label,
      group: "Pages",
      href,
    })),
    ...projects.map(({ id, name }) => ({
      id: `project:${id}`,
      label: name,
      group: "Projects",
      href: switchProjectHref(pathname, id),
    })),
    ...(root
      ? [
          { id: "org:projects", label: "All projects", group: "Projects", href: root },
          {
            id: "org:new-project",
            label: "New project",
            group: "Projects",
            href: newProjectHref(root),
          },
        ]
      : []),
  ];
}

function matches(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Where `g` then `key` goes, or null when no rail item owns the key. */
export function shortcutHref(items: readonly NavItem[], key: string): string | null {
  return flattenNav(items).find((item) => item.shortcut === key.toLowerCase())?.href ?? null;
}

/** The item for this path, children included; the longest matching href wins. */
export function activeNavItemId(pathname: string, items: readonly NavItem[]): string | null {
  let best: NavItem | null = null;
  for (const item of flattenNav(items)) {
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

/** The projects page with its New project dialog open. */
export function newProjectHref(organizationHref: string): string {
  return `${organizationHref}?new=1`;
}

/** Where the console opens: the first project, else the organization's projects page. */
export function entryHref(
  projects: readonly { id: string }[],
  organizationSlug: string | undefined,
): string | null {
  if (projects[0]) return projectRoot(projects[0].id);
  return organizationSlug ? organizationRoot(organizationSlug) : null;
}
