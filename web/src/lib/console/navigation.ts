import type {
  NavItem as EditionNavItem,
  NavIconName,
  OrganizationNavItem,
  ProjectNavGroup,
} from "@/lib/composition/ports";

export type { NavIconName };

/**
 * The console navigation (DESIGN.md, Information architecture). Pure functions of the URL and the
 * composition, so the rail, ⌘K, the `g` shortcuts and the tests read one model. Only destinations
 * this build has are listed: a page that has not landed is absent, never disabled. Items list
 * every path they absorb in `also`, so the rail lights the right item wherever the reader is, old
 * URLs included.
 */

export interface NavItem {
  /** Stable across renders and projects: core ids are fixed, edition ids derive from the href. */
  id: string;
  label: string;
  href: string;
  icon: NavIconName;
  /** The item is the current page only on this exact path (index pages). */
  exact?: boolean;
  /** Paths this item has absorbed; any of them, or anything under them, selects it. */
  also?: readonly string[];
  /** The key after `g` that jumps here. */
  shortcut?: string;
  /** Other words ⌘K finds it by. */
  keywords?: readonly string[];
  /** The rail item to select when this destination matches. Defaults to this item's id. */
  activeId?: string;
  /**
   * The rail section it sits in; the rail leaves a gap between sections. Absent means `main`.
   * `footer` items leave the scrolling list: they are pinned at the rail's foot, above the account.
   */
  section?: "settings" | "footer" | "edition" | `group:${string}`;
  /** The section's heading, on its first item (an edition's project group). */
  sectionLabel?: string;
  /** Sub-pages folded under this item; its own href is the group's landing page. */
  children?: readonly NavItem[];
}

/** The rail's scrolling list and its pinned footer, each in rail order. */
export function railParts(items: readonly NavItem[]): { list: NavItem[]; footer: NavItem[] } {
  return {
    list: items.filter((item) => item.section !== "footer"),
    footer: items.filter((item) => item.section === "footer"),
  };
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
  organizationAdditions = [],
  projectGroups = [],
  entityPages = false,
  focusedConsole = false,
  sandboxPage = false,
  customMonitoring = false,
  evalsPage = false,
}: {
  projectId: string | undefined;
  organizationSlug?: string;
  additions: readonly EditionNavItem[];
  /** Organization pages the edition adds (`composition.organizationNav`), after Projects. */
  organizationAdditions?: readonly OrganizationNavItem[];
  /**
   * Project page groups the edition adds (`composition.projectNav`): a labelled section before
   * Catalog and Settings, or a group with `row` as one collapsible row between them.
   */
  projectGroups?: readonly ProjectNavGroup[];
  /**
   * `agentsPages` on for the shown organization (RP-28): Agents and MCP servers under Traces.
   * Upstream also needs the project's data for each (`lib/agents/navigation.ts`); here both show
   * whenever the flag is on, and each page has its own empty state.
   */
  entityPages?: boolean;
  /** `focusedConsole` on for the shown organization (`lib/console/focused-console`). */
  focusedConsole?: boolean;
  /** `sandboxes` on for the shown organization: Ratel sandbox before Catalog and Settings. */
  sandboxPage?: boolean;
  /** `customMonitoring` on for the shown organization: Dashboards, Explore and Alerts in Monitor. */
  customMonitoring?: boolean;
  /** `evals` on for the shown organization: Evals before Ratel sandbox. */
  evalsPage?: boolean;
}): NavItem[] {
  const root = projectId ? projectRoot(projectId) : null;
  const projectPage = (item: ProjectNavGroup["items"][number]): NavItem => ({
    id: `project-${item.path}`,
    label: item.label,
    href: `${root}/${item.path}`,
    icon: item.icon ?? "edition",
    ...(item.shortcut ? { shortcut: item.shortcut } : {}),
    ...(item.keywords ? { keywords: item.keywords } : {}),
  });
  const organization: NavItem[] = organizationSlug
    ? [
        {
          id: "projects",
          label: "Projects",
          href: organizationRoot(organizationSlug),
          icon: "projects",
          exact: true,
          shortcut: "o",
          keywords: ["agents", "home"],
        },
        ...organizationAdditions.map(
          (item): NavItem => ({
            id: `org-${item.path}`,
            label: item.label,
            href: `${organizationRoot(organizationSlug)}/${item.path}`,
            icon: item.icon ?? "members",
            ...(item.shortcut ? { shortcut: item.shortcut } : {}),
            ...(item.keywords ? { keywords: item.keywords } : {}),
          }),
        ),
        {
          id: "integrations",
          label: "Integrations",
          href: `${organizationRoot(organizationSlug)}/mcp`,
          icon: "integrations",
          keywords: ["mcp", "connect", "claude", "cursor", "model context protocol"],
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
          also: [`${root}/dashboards`, `${root}/insights`],
          shortcut: "o",
          keywords: ["home", "summary", "dashboard", "needs attention"],
        },
        {
          id: "health",
          label: "Agent health",
          href: `${root}/health`,
          icon: "health",
          exact: true,
          also: [`${root}/improvement/health`],
          shortcut: "h",
          keywords: ["signals", "issues", "problems", "first try", "detours"],
          children: [
            {
              id: "health-summary",
              label: "Summary",
              href: `${root}/health`,
              icon: "health",
              exact: true,
              keywords: ["readings", "issues", "turn shapes", "flow map"],
            },
            {
              id: "health-tasks",
              label: "Tasks",
              href: `${root}/health/tasks`,
              icon: "health",
              also: [`${root}/improvement/tool-explorer`],
              keywords: [
                "task pipelines",
                "steps",
                "tools run together",
                "workflows",
                "tool craft",
                "finish rate",
              ],
            },
            {
              id: "health-self-corrections",
              label: "Self-corrections",
              href: `${root}/health/self-corrections`,
              icon: "health",
              keywords: ["retries", "apologies", "sorry", "tried again", "gave up", "backtracks"],
            },
          ],
        },
        {
          id: "traces",
          label: "Traces",
          href: `${root}/traces`,
          icon: "traces",
          shortcut: "t",
          keywords: ["runs", "spans", "logs", "requests"],
        },
        {
          id: "catalog",
          label: "Catalog",
          href: `${root}/catalogs`,
          icon: "catalog",
          exact: true,
          shortcut: "c",
          keywords: ["tools", "skills", "descriptions", "tree", "all items"],
          children: [
            {
              id: "catalog-tools",
              label: "Tools",
              href: `${root}/catalogs/tools`,
              icon: "catalog",
              keywords: ["functions", "calls", "mcp"],
            },
            {
              id: "catalog-skills",
              label: "Skills",
              href: `${root}/catalogs/skills`,
              icon: "catalog",
              keywords: ["instructions", "prompts"],
            },
            {
              id: "catalog-test",
              label: "Test a search",
              href: `${root}/playground`,
              icon: "catalog",
              keywords: ["playground", "ranking", "query", "what-if"],
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
          keywords: ["what people ask", "what people want", "topics", "flows", "map"],
          children: [
            {
              id: "intents-topics",
              label: "All intents",
              href: `${root}/intents`,
              icon: "intents",
              exact: true,
              also: [`${root}/intents/asks`],
              keywords: ["topics", "asks", "ask groups", "requests", "sentiment", "unanswered"],
            },
            {
              id: "intents-flows",
              label: "Flows",
              href: `${root}/intents/flows`,
              icon: "intents",
              keywords: [
                "what people ask next",
                "steps",
                "sessions",
                "conversations",
                "intent flows",
              ],
            },
            {
              id: "intents-map",
              label: "Map",
              href: `${root}/intents/map`,
              icon: "intents",
              keywords: ["intent map", "tools network", "co-usage", "tools used together", "graph"],
            },
          ],
        },
        {
          id: "improvements",
          label: "Improvements",
          href: `${root}/improvement`,
          icon: "improvements",
          exact: true,
          keywords: ["improve", "fixes", "proposals"],
          children: [
            {
              id: "fixes",
              label: "Fixes",
              href: `${root}/improvement/fixes`,
              icon: "improvements",
              also: [`${root}/improvement/tool-explorer/suggestions`],
              shortcut: "f",
              keywords: [
                "suggestions",
                "proposals",
                "rewrite",
                "retire",
                "merge",
                "tool craft",
                "what to change",
              ],
            },
            {
              id: "quality",
              label: "Quality",
              href: `${root}/quality`,
              icon: "improvements",
              also: [`${root}/quality`, `${root}/calibration`, `${root}/improvement/match-quality`],
              shortcut: "q",
              keywords: [
                "misses",
                "mismatches",
                "experiments",
                "calibration",
                "match quality",
                "descriptions",
                "rewrites",
                "searchable description",
              ],
            },
            {
              id: "adaptive-ranking",
              label: "Adaptive ranking",
              href: `${root}/improvement/adaptive-ranking`,
              icon: "improvements",
              shortcut: "a",
              keywords: ["ranking", "boost", "recall", "intent graph"],
            },
          ],
        },
        ...projectGroups
          .filter((group) => !group.row)
          .flatMap((group) =>
            group.items.map(
              (item, index): NavItem => ({
                ...projectPage(item),
                section: `group:${group.id}`,
                ...(index === 0 ? { sectionLabel: group.label } : {}),
              }),
            ),
          ),
        {
          id: "mcp-setup",
          label: "MCP",
          href: `${root}/mcp-setup`,
          icon: "integrations",
          keywords: [
            "mcp",
            "connect",
            "claude",
            "cursor",
            "model context protocol",
            "integrations",
          ],
          section: "footer",
        },
        {
          id: "settings",
          label: "Settings",
          href: `${root}/settings`,
          icon: "settings",
          also: [`${root}/runtime-events`],
          shortcut: "s",
          keywords: ["api keys", "developer", "sdk events", "danger zone"],
          section: "settings",
        },
      ]
    : organization;
  // Upstream's APIs row: one collapsible row whose landing page is its first sub-page.
  const setupRows: NavItem[] = root
    ? projectGroups.flatMap((group) => {
        const children = group.items.map(projectPage);
        if (!group.row || !children[0]) return [];
        return [
          {
            id: `group-${group.id}`,
            label: group.label,
            href: children[0].href,
            icon: group.row.icon ?? "edition",
            exact: true,
            ...(group.row.keywords ? { keywords: group.row.keywords } : {}),
            children,
          },
        ];
      })
    : [];
  return [
    ...(root
      ? stageRailNav(root, core, setupRows, {
          entityPages,
          focusedConsole,
          customMonitoring,
          sandboxPage,
          evalsPage,
        })
      : core),
    ...additions.map((item) => ({
      id: `edition:${item.href}`,
      label: item.label,
      href: item.href,
      icon: "edition" as const,
      ...(item.keywords ? { keywords: item.keywords } : {}),
      section: "edition" as const,
    })),
  ];
}

/**
 * Group the project rail by stage (upstream's `stageRailNav`, in this flat model: a stage is a
 * labelled section). Monitor contains Agent health, without its Tasks child and lit as one item;
 * Insights contains Tasks, a top-level page (`/tasks`) that absorbs the Agent health Tasks pages.
 * Ship is new. With `customMonitoring`, Monitor also has Dashboards, Explore and Alerts. With `focusedConsole`, Agent health has no sub-page and Self-corrections is an
 * Insights page (`/self-corrections`) that absorbs its Agent health path. Catalog, the edition's setup rows and Settings close the list, unlabelled; MCP sits in the footer.
 */
function stageRailNav(
  root: string,
  classic: readonly NavItem[],
  setupRows: readonly NavItem[],
  {
    entityPages,
    focusedConsole,
    customMonitoring,
    sandboxPage,
    evalsPage,
  }: {
    entityPages: boolean;
    focusedConsole: boolean;
    customMonitoring: boolean;
    sandboxPage: boolean;
    evalsPage: boolean;
  },
): NavItem[] {
  const pick = (id: string): NavItem => {
    const item = classic.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`the classic rail has no ${id}`);
    return item;
  };
  const stage = (id: string, label: string, items: NavItem[]): NavItem[] =>
    items.map((item, index) => ({
      ...item,
      section: `group:${id}` as const,
      ...(index === 0 ? { sectionLabel: label } : {}),
    }));
  const classicHealth = pick("health");
  const healthPages = (classicHealth.children ?? []).filter((item) => item.id !== "health-tasks");
  const health: NavItem = {
    ...classicHealth,
    children: focusedConsole
      ? undefined
      : healthPages.map((item) => ({ ...item, activeId: classicHealth.id })),
  };
  const selfCorrections: NavItem[] = focusedConsole
    ? healthPages
        .filter((item) => item.id === "health-self-corrections")
        .map((item) => ({
          ...item,
          id: "self-corrections",
          href: `${root}/self-corrections`,
          icon: "self-corrections",
          also: [item.href],
        }))
    : [];
  const tasks: NavItem = {
    id: "tasks",
    label: "Tasks",
    href: `${root}/tasks`,
    icon: "tasks",
    shortcut: "w",
    also: [`${root}/health/tasks`, `${root}/improvement/tool-explorer`],
    keywords: ["tasks", "workflows", "scores", "issues", "tool craft"],
  };
  const ship: NavItem = {
    id: "ship",
    label: "Ship",
    href: `${root}/ship`,
    icon: "ship",
    shortcut: "l",
    keywords: ["shipped", "live", "released", "deployed", "applied", "shipments"],
  };
  // Upstream's entities (RC-775, RC-777) fold under Traces, so the rail keeps its budget.
  const classicTraces = pick("traces");
  const traces: NavItem = entityPages
    ? {
        ...classicTraces,
        children: [
          {
            id: "traces-all",
            label: "All traces",
            href: classicTraces.href,
            icon: "traces",
            activeId: classicTraces.id,
          },
          {
            id: "agents",
            label: "Agents",
            href: `${root}/agents`,
            icon: "traces",
            keywords: ["agents", "multi-agent", "sub-agents", "handoffs", "cost", "errors"],
          },
          {
            id: "mcp-servers",
            label: "MCP servers",
            href: `${root}/mcp`,
            icon: "traces",
            keywords: ["mcp", "model context protocol", "servers", "tools", "latency", "errors"],
          },
        ],
      }
    : classicTraces;
  const overview = pick("overview");
  return [
    ...stage(
      "monitor",
      "Monitor",
      customMonitoring
        ? withMonitoringPages(root, { overview, health, traces })
        : [overview, health, traces],
    ),
    ...stage("insights", "Insights", [tasks, pick("intents"), ...selfCorrections]),
    ...stage("improve", "Improve", [pick("improvements")]),
    ...stage("ship", "Ship", [ship]),
    ...classic.filter((item) => item.section?.startsWith("group:")),
    ...(evalsPage
      ? [
          {
            id: "evals",
            label: "Evals",
            href: `${root}/evals`,
            icon: "improvements" as const,
            keywords: ["evals", "cases", "experiments", "trials"],
            section: "settings" as const,
          },
        ]
      : []),
    ...(sandboxPage
      ? [
          {
            id: "sandbox",
            label: "Ratel sandbox",
            href: `${root}/sandbox`,
            icon: "apis" as const,
            keywords: ["sandbox", "push", "versions", "secrets", "run"],
            section: "settings" as const,
          },
        ]
      : []),
    { ...pick("catalog"), section: "settings" },
    ...setupRows.map((item) => ({ ...item, section: "settings" as const })),
    pick("mcp-setup"),
    pick("settings"),
  ];
}

/**
 * Monitor with the `customMonitoring` pages, each an item of its own: they are destinations as much as
 * the pages beside them. Overview gives up `/dashboards`, which is then a page and not an old address.
 */
function withMonitoringPages(
  root: string,
  { overview, health, traces }: { overview: NavItem; health: NavItem; traces: NavItem },
): NavItem[] {
  const dashboards: NavItem = {
    id: "dashboards",
    label: "Dashboards",
    href: `${root}/dashboards`,
    icon: "dashboards",
    // A scorer has no list page: it is picked where it is used. One scorer's page lights Dashboards.
    also: [`${root}/scorers`],
    keywords: ["dashboards", "widgets", "charts", "metrics", "scorers", "scores", "judge"],
  };
  return [
    { ...overview, also: overview.also?.filter((path) => path !== dashboards.href) },
    dashboards,
    {
      id: "explore",
      label: "Explore",
      href: `${root}/explore`,
      icon: "explore",
      keywords: ["query", "analyze", "playground", "charts", "funnel", "flow"],
    },
    health,
    traces,
    {
      id: "alerts",
      label: "Alerts",
      href: `${root}/alerts`,
      icon: "alerts",
      keywords: ["threshold", "notifications", "slack", "monitors"],
    },
  ];
}

export type CommandEntry = {
  id: string;
  label: string;
  group: string;
  href: string;
  keywords?: readonly string[];
};

/**
 * Everything ⌘K reaches: every rail item, the pages that live one level down, from inside a
 * project its organization's pages too, then every project at the section being read. A page is
 * listed once, under the first item that leads to it.
 */
export function commandEntries({
  items,
  organizationItems = [],
  projectId,
  projects,
  pathname,
  organizationSlug,
}: {
  /** The rail being shown. */
  items: readonly NavItem[];
  /** The organization's rail, when `items` is a project's. */
  organizationItems?: readonly NavItem[];
  /** The project `items` belongs to; absent on the organization rail. */
  projectId?: string;
  projects: readonly { id: string; name: string }[];
  pathname: string;
  organizationSlug?: string;
}): CommandEntry[] {
  const pages: CommandEntry[] = [];
  const add = (group: string, rail: readonly NavItem[]) => {
    for (const { label, href, keywords, section } of flattenNav(rail)) {
      pages.push({
        id: href,
        label,
        // An edition's own destinations (`composition.nav`) belong to neither scope.
        group: section === "edition" ? "Pages" : group,
        href,
        ...(keywords ? { keywords } : {}),
      });
    }
  };
  if (projectId) {
    const root = projectRoot(projectId);
    const below = (path: string, label: string, group: string, keywords: string[]) =>
      pages.push({ id: `${root}/${path}`, label, group, href: `${root}/${path}`, keywords });
    add("Project", items);
    below("dashboards", "Usage and spend", "Overview", ["dashboards", "cost", "tokens", "context"]);
    below("settings/api-keys", "API keys", "Settings", ["sdk", "token", "credentials", "connect"]);
    below("settings/danger", "Danger zone", "Settings", ["delete project"]);
    below("calibration", "Experiments", "Quality", ["calibration", "comparison", "shadow"]);
    below("runtime-events", "SDK events", "Settings", [
      "runtime events",
      "dropped",
      "rejected",
      "developer",
    ]);
    add("Organization", organizationItems);
  } else {
    add("Organization", items);
  }
  const seen = new Set<string>();
  return [
    ...pages.filter((entry) => {
      if (seen.has(entry.href)) return false;
      seen.add(entry.href);
      return true;
    }),
    ...projects.map(({ id, name }) => ({
      id: `project:${id}`,
      label: name,
      group: "Projects",
      href: switchProjectHref(pathname, id),
    })),
    ...(organizationSlug
      ? [
          {
            id: "org:projects",
            label: "All projects",
            group: "Projects",
            href: organizationRoot(organizationSlug),
          },
          {
            id: "org:new-project",
            label: "New project",
            group: "Projects",
            href: newProjectHref(organizationSlug),
          },
        ]
      : []),
  ];
}

function matches(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

/** Where `g` then `key` goes, or null when no rail item owns the key. */
export function shortcutHref(items: readonly NavItem[], key: string): string | null {
  return flattenNav(items).find((item) => item.shortcut === key.toLowerCase())?.href ?? null;
}

/**
 * The item for the current page: the one whose own path or absorbed path matches most
 * specifically, children included, so `/catalogs/tools` selects Tools rather than the Catalog
 * group above it.
 */
export function activeNavItemId(pathname: string, items: readonly NavItem[]): string | null {
  let best: { id: string; length: number } | null = null;
  for (const item of flattenNav(items)) {
    const candidates: string[] = [];
    if (item.exact ? pathname === item.href : matches(pathname, item.href)) {
      candidates.push(item.href);
    }
    for (const path of item.also ?? []) if (matches(pathname, path)) candidates.push(path);
    // On a tie the later item wins: a group's first child shares the group's path (Intents and
    // All intents), and the child is the page the reader is on.
    for (const path of candidates) {
      if (!best || path.length >= best.length) {
        best = { id: item.activeId ?? item.id, length: path.length };
      }
    }
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

/** The project-creation flow, outside the console shell: the first project and every later one. */
export const ONBOARDING_ROUTE = "/onboarding";

/** "New project": onboarding for the organization, which creates the project and its API key. */
export function newProjectHref(organizationSlug: string): string {
  return `${ONBOARDING_ROUTE}?organization=${encodeURIComponent(organizationSlug)}`;
}

/**
 * Where the console opens: the first project, else onboarding, so a fresh install sets up its
 * first project before it meets an empty projects page. Null without an organization.
 */
export function entryHref(
  projects: readonly { id: string }[],
  organizationSlug: string | undefined,
): string | null {
  if (projects[0]) return projectRoot(projects[0].id);
  return organizationSlug ? ONBOARDING_ROUTE : null;
}

/**
 * The organization the shell shows (upstream's `AppFrame`): the open project's own, else the one
 * the route names, else the active one, else the first. The reader may be in a project or an
 * organization page of any organization they belong to; the active one is only the fallback.
 */
export function shellOrganization<O extends { id: string; slug: string }>(
  organizations: readonly O[],
  projects: readonly { id: string; organizationId: string }[],
  pathname: string,
  activeSlug?: string | null,
): O | undefined {
  const project = findProject(projects, projectIdFromPath(pathname));
  const routeSlug = organizationSlugFromPath(pathname);
  return (
    organizations.find(({ id }) => id === project?.organizationId) ??
    organizations.find(({ slug }) => slug === routeSlug) ??
    organizations.find(({ slug }) => slug === activeSlug) ??
    organizations[0]
  );
}

/** The edition's organization pages without the paths it hides for this organization. */
export function visibleOrganizationNav(
  nav: readonly OrganizationNavItem[],
  hidden: readonly string[],
): OrganizationNavItem[] {
  return nav.filter((item) => !hidden.includes(item.path));
}
