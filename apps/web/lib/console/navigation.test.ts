import assert from "node:assert/strict";
import { test } from "node:test";
import { createComposition } from "@/lib/composition/ports";
import {
  activeNavItemId,
  commandEntries,
  consoleNav,
  entryHref,
  findProject,
  ONBOARDING_ROUTE,
  organizationRoot,
  organizationSlugFromPath,
  projectIdFromPath,
  projectRoot,
  shortcutHref,
  switchProjectHref,
  visibleOrganizationNav,
} from "./navigation";
import { searchCommands } from "./scope/command-search";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const PROJECTS = [
  { id: P1, name: "One" },
  { id: P2, name: "Two" },
];

test("project URLs are rooted at /project/<id>, encoded", () => {
  assert.equal(projectRoot(P1), `/project/${P1}`);
  assert.equal(projectRoot("a b/c"), "/project/a%20b%2Fc");
});

test("the project id is read back from the path", () => {
  assert.equal(projectIdFromPath(`/project/${P1}`), P1);
  assert.equal(projectIdFromPath(`/project/${P1}/catalog/tools`), P1);
  assert.equal(projectIdFromPath("/project/a%20b"), "a b");
  assert.equal(projectIdFromPath("/project/%E0%A4%A"), "%E0%A4%A");
  assert.equal(projectIdFromPath("/"), undefined);
  assert.equal(projectIdFromPath("/admin"), undefined);
});

test("with a project, the rail links every core destination to that project", () => {
  const items = consoleNav({ projectId: P1, additions: [] });
  assert.deepEqual(
    items.map(({ id, href }) => ({ id, href })),
    [
      { id: "overview", href: `/project/${P1}` },
      { id: "health", href: `/project/${P1}/health` },
      { id: "traces", href: `/project/${P1}/traces` },
      { id: "catalog", href: `/project/${P1}/catalogs` },
      { id: "intents", href: `/project/${P1}/intents` },
      { id: "improvements", href: `/project/${P1}/improvement` },
      { id: "settings", href: `/project/${P1}/settings` },
    ],
  );
  const health = items.find(({ id }) => id === "health");
  assert.deepEqual(
    health?.children?.map(({ id, href }) => ({ id, href })),
    [
      { id: "health-summary", href: `/project/${P1}/health` },
      { id: "health-tasks", href: `/project/${P1}/health/tasks` },
      { id: "health-self-corrections", href: `/project/${P1}/health/self-corrections` },
    ],
  );
  const intents = items.find(({ id }) => id === "intents");
  assert.deepEqual(
    intents?.children?.map(({ id, href }) => ({ id, href })),
    [
      { id: "intents-topics", href: `/project/${P1}/intents` },
      { id: "intents-flows", href: `/project/${P1}/intents/flows` },
      { id: "intents-map", href: `/project/${P1}/intents/map` },
    ],
  );
  const improvements = items.find(({ id }) => id === "improvements");
  assert.deepEqual(
    improvements?.children?.map(({ id, href }) => ({ id, href })),
    [
      { id: "fixes", href: `/project/${P1}/improvement/fixes` },
      { id: "quality", href: `/project/${P1}/quality` },
      { id: "adaptive-ranking", href: `/project/${P1}/improvement/adaptive-ranking` },
    ],
  );
  const catalog = items.find(({ id }) => id === "catalog");
  assert.deepEqual(
    catalog?.children?.map(({ id, href }) => ({ id, href })),
    [
      { id: "catalog-tools", href: `/project/${P1}/catalogs/tools` },
      { id: "catalog-skills", href: `/project/${P1}/catalogs/skills` },
      { id: "catalog-test", href: `/project/${P1}/playground` },
    ],
  );
});

test("without a project, project-scoped destinations are absent, not disabled", () => {
  assert.deepEqual(consoleNav({ projectId: undefined, additions: [] }), []);
});

test("outside a project, the organization rail lists its projects page", () => {
  assert.equal(organizationRoot("local operator"), "/org/local%20operator");
  assert.equal(organizationSlugFromPath("/org/acme"), "acme");
  assert.equal(organizationSlugFromPath("/org/acme/settings"), "acme");
  assert.equal(organizationSlugFromPath(`/project/${P1}`), undefined);
  const items = consoleNav({ projectId: undefined, organizationSlug: "acme", additions: [] });
  assert.deepEqual(
    items.map(({ id, href }) => ({ id, href })),
    [
      { id: "projects", href: "/org/acme" },
      { id: "integrations", href: "/org/acme/mcp" },
      { id: "org-settings", href: "/org/acme/settings" },
    ],
  );
  assert.equal(activeNavItemId("/org/acme", items), "projects");
  assert.equal(activeNavItemId("/org/acme/mcp", items), "integrations");
  assert.equal(activeNavItemId("/org/acme/settings", items), "org-settings");
  // An edition's organization pages sit right after Projects, with their own icons.
  const cloud = consoleNav({
    projectId: undefined,
    organizationSlug: "acme",
    additions: [],
    organizationAdditions: [
      { path: "team", label: "Members" },
      { path: "billing", label: "Billing", icon: "billing" },
    ],
  });
  assert.deepEqual(
    cloud.map(({ id, href }) => ({ id, href })),
    [
      { id: "projects", href: "/org/acme" },
      { id: "org-team", href: "/org/acme/team" },
      { id: "org-billing", href: "/org/acme/billing" },
      { id: "integrations", href: "/org/acme/mcp" },
      { id: "org-settings", href: "/org/acme/settings" },
    ],
  );
  assert.equal(activeNavItemId("/org/acme/team", cloud), "org-team");
  assert.deepEqual(
    cloud
      .filter(({ id }) => id.startsWith("org-") && id !== "org-settings")
      .map(({ icon }) => icon),
    ["members", "billing"],
  );
  // Inside a project the rail is the project's, even when the organization is known.
  assert.deepEqual(
    consoleNav({ projectId: P1, organizationSlug: "acme", additions: [] }).map(({ id }) => id),
    ["overview", "health", "traces", "catalog", "intents", "improvements", "settings"],
  );
});

test("composition additions follow the core destinations with stable ids", () => {
  const additions = [{ href: "/admin", label: "Admin" }];
  const withProject = consoleNav({ projectId: P1, additions });
  const without = consoleNav({ projectId: undefined, additions });
  assert.deepEqual(withProject.at(-1), {
    id: "edition:/admin",
    href: "/admin",
    label: "Admin",
    icon: "edition",
    section: "edition",
  });
  assert.equal(withProject.length, 8);
  assert.deepEqual(
    without.map(({ id }) => id),
    ["edition:/admin"],
  );
});

test("the OSS composition adds no destination", () => {
  const oss = createComposition("oss");
  const items = consoleNav({
    projectId: P1,
    additions: oss.nav,
    projectGroups: oss.projectNav,
  });
  assert.deepEqual(
    items.map(({ id }) => id),
    ["overview", "health", "traces", "catalog", "intents", "improvements", "settings"],
  );
  assert.ok(items.every(({ sectionLabel }) => sectionLabel === undefined));
});

test("an edition's project group sits between the core pages and Settings, under its label", () => {
  const items = consoleNav({
    projectId: P1,
    additions: [],
    projectGroups: [
      {
        id: "apis",
        label: "APIs",
        items: [
          { path: "models/embeddings", label: "Embeddings", icon: "embeddings", shortcut: "e" },
          { path: "models/tool-picker", label: "Tool Picker" },
        ],
      },
    ],
  });
  assert.deepEqual(
    items.map(
      ({ id, section, sectionLabel }) => `${section ?? "main"}:${id}:${sectionLabel ?? ""}`,
    ),
    [
      "main:overview:",
      "main:health:",
      "main:traces:",
      "main:catalog:",
      "main:intents:",
      "main:improvements:",
      "group:apis:project-models/embeddings:APIs",
      "group:apis:project-models/tool-picker:",
      "settings:settings:",
    ],
  );
  const [embeddings, toolPicker] = items.filter(({ section }) => section === "group:apis");
  assert.equal(embeddings.href, `/project/${P1}/models/embeddings`);
  assert.equal(embeddings.icon, "embeddings");
  assert.equal(toolPicker.icon, "edition");
  assert.equal(shortcutHref(items, "e"), `/project/${P1}/models/embeddings`);
  assert.equal(
    activeNavItemId(`/project/${P1}/models/embeddings`, items),
    "project-models/embeddings",
  );
  // The organization rail never shows a project group.
  assert.deepEqual(
    consoleNav({
      projectId: undefined,
      organizationSlug: "acme",
      additions: [],
      projectGroups: [{ id: "apis", label: "APIs", items: [{ path: "x", label: "X" }] }],
    }).map(({ id }) => id),
    ["projects", "integrations", "org-settings"],
  );
});

test("Settings sits in a section of its own in both rails, the edition's items in another", () => {
  const sectionsOf = (items: ReturnType<typeof consoleNav>) =>
    items.map(({ id, section }) => `${section ?? "main"}:${id}`);
  assert.deepEqual(
    sectionsOf(consoleNav({ projectId: P1, additions: [{ href: "/admin", label: "Admin" }] })),
    [
      "main:overview",
      "main:health",
      "main:traces",
      "main:catalog",
      "main:intents",
      "main:improvements",
      "settings:settings",
      "edition:edition:/admin",
    ],
  );
  assert.deepEqual(
    sectionsOf(consoleNav({ projectId: undefined, organizationSlug: "acme", additions: [] })),
    ["main:projects", "main:integrations", "settings:org-settings"],
  );
});

test("the active item matches exact index pages and nested paths", () => {
  const items = consoleNav({ projectId: P1, additions: [{ href: "/admin", label: "Admin" }] });
  assert.equal(activeNavItemId(`/project/${P1}`, items), "overview");
  assert.equal(activeNavItemId(`/project/${P1}/settings`, items), "settings");
  assert.equal(activeNavItemId(`/project/${P1}/settings/general`, items), "settings");
  assert.equal(activeNavItemId(`/project/${P1}/traces/abc`, items), "traces");
  // The Summary child shares the group's href: the most specific item wins, and the group opens around it.
  assert.equal(activeNavItemId(`/project/${P1}/health`, items), "health-summary");
  assert.equal(activeNavItemId(`/project/${P1}/health/tasks/t1`, items), "health-tasks");
  assert.equal(activeNavItemId(`/project/${P1}/intents/map`, items), "intents-map");
  assert.equal(activeNavItemId(`/project/${P1}/catalogs`, items), "catalog");
  assert.equal(activeNavItemId(`/project/${P1}/catalogs/tools`, items), "catalog-tools");
  assert.equal(activeNavItemId(`/project/${P1}/catalogs/skills/x`, items), "catalog-skills");
  assert.equal(activeNavItemId(`/project/${P1}/unknown`, items), null);
  assert.equal(activeNavItemId("/admin", items), "edition:/admin");
  assert.equal(activeNavItemId("/admin/users", items), "edition:/admin");
  assert.equal(activeNavItemId("/administer", items), null);
});

test("an item is lit on every path it has absorbed, old URLs included", () => {
  const items = consoleNav({ projectId: P1, additions: [] });
  const active = (path: string) => activeNavItemId(`/project/${P1}${path}`, items);
  assert.equal(active("/dashboards"), "overview");
  assert.equal(active("/insights"), "overview");
  assert.equal(active("/improvement/health"), "health");
  assert.equal(active("/improvement/tool-explorer"), "health-tasks");
  // The longer absorbed path wins over the shorter one above it.
  assert.equal(active("/improvement/tool-explorer/suggestions"), "fixes");
  assert.equal(active("/intents/asks"), "intents-topics");
  assert.equal(active("/quality"), "quality");
  assert.equal(active("/calibration"), "quality");
  assert.equal(active("/calibration/exp-1"), "quality");
  assert.equal(active("/improvement/match-quality"), "quality");
  assert.equal(active("/runtime-events"), "settings");
  assert.equal(active("/calibrations"), null, "an absorbed path matches whole segments");
});

test("switching project keeps the section the reader is on", () => {
  assert.equal(switchProjectHref(`/project/${P1}`, P2), `/project/${P2}`);
  assert.equal(
    switchProjectHref(`/project/${P1}/catalog/tools?q=x`, P2),
    `/project/${P2}/catalog/tools?q=x`,
  );
  assert.equal(switchProjectHref("/", P2), `/project/${P2}`);
  assert.equal(switchProjectHref("/admin", P2), `/project/${P2}`);
});

test("a project outside the organization's list is not found", () => {
  assert.equal(findProject(PROJECTS, P2)?.name, "Two");
  assert.equal(findProject(PROJECTS, "33333333-3333-4333-8333-333333333333"), undefined);
  assert.equal(findProject(PROJECTS, undefined), undefined);
  assert.equal(findProject([], P1), undefined);
});

test("the entry goes to the first project, else to onboarding, else nowhere", () => {
  assert.equal(entryHref(PROJECTS, "acme"), `/project/${P1}`);
  assert.equal(entryHref([], "acme"), ONBOARDING_ROUTE);
  assert.equal(ONBOARDING_ROUTE, "/onboarding");
  assert.equal(entryHref([], undefined), null);
});

test("the command menu lists the project's pages, the organization's, then every project", () => {
  const additions = [{ href: "/admin", label: "Admin" }];
  const entries = commandEntries({
    items: consoleNav({ projectId: P1, additions }),
    organizationItems: consoleNav({ projectId: undefined, organizationSlug: "acme", additions }),
    projectId: P1,
    projects: PROJECTS,
    pathname: `/project/${P1}/traces`,
    organizationSlug: "acme",
  });
  // A page is listed once: Summary and All intents share their group's address, and the
  // edition's Admin is on both rails.
  assert.deepEqual(
    entries.map(({ label, group, href }) => `${group}|${label}|${href}`),
    [
      `Project|Overview|/project/${P1}`,
      `Project|Agent health|/project/${P1}/health`,
      `Project|Tasks|/project/${P1}/health/tasks`,
      `Project|Self-corrections|/project/${P1}/health/self-corrections`,
      `Project|Traces|/project/${P1}/traces`,
      `Project|Catalog|/project/${P1}/catalogs`,
      `Project|Tools|/project/${P1}/catalogs/tools`,
      `Project|Skills|/project/${P1}/catalogs/skills`,
      `Project|Test a search|/project/${P1}/playground`,
      `Project|Intents|/project/${P1}/intents`,
      `Project|Flows|/project/${P1}/intents/flows`,
      `Project|Map|/project/${P1}/intents/map`,
      `Project|Improvements|/project/${P1}/improvement`,
      `Project|Fixes|/project/${P1}/improvement/fixes`,
      `Project|Quality|/project/${P1}/quality`,
      `Project|Adaptive ranking|/project/${P1}/improvement/adaptive-ranking`,
      `Project|Settings|/project/${P1}/settings`,
      "Pages|Admin|/admin",
      `Overview|Usage and spend|/project/${P1}/dashboards`,
      `Settings|API keys|/project/${P1}/settings/api-keys`,
      `Settings|Danger zone|/project/${P1}/settings/danger`,
      `Quality|Experiments|/project/${P1}/calibration`,
      `Settings|SDK events|/project/${P1}/runtime-events`,
      "Organization|Projects|/org/acme",
      "Organization|Integrations|/org/acme/mcp",
      "Organization|Settings|/org/acme/settings",
      `Projects|One|/project/${P1}/traces`,
      `Projects|Two|/project/${P2}/traces`,
      "Projects|All projects|/org/acme",
      "Projects|New project|/onboarding?organization=acme",
    ],
  );
  assert.equal(new Set(entries.map(({ id }) => id)).size, entries.length);
});

test("outside a project the command menu lists the organization's pages only", () => {
  const entries = commandEntries({
    items: consoleNav({ projectId: undefined, organizationSlug: "acme", additions: [] }),
    projects: PROJECTS,
    pathname: "/org/acme",
    organizationSlug: "acme",
  });
  assert.deepEqual(
    entries.map(({ label, group, href }) => `${group}|${label}|${href}`),
    [
      "Organization|Projects|/org/acme",
      "Organization|Integrations|/org/acme/mcp",
      "Organization|Settings|/org/acme/settings",
      `Projects|One|/project/${P1}`,
      `Projects|Two|/project/${P2}`,
      "Projects|All projects|/org/acme",
      "Projects|New project|/onboarding?organization=acme",
    ],
  );
});

test("the command menu finds a page by its keywords, not only its name", () => {
  const entries = commandEntries({
    items: consoleNav({ projectId: P1, additions: [] }),
    organizationItems: consoleNav({
      projectId: undefined,
      organizationSlug: "acme",
      additions: [],
    }),
    projectId: P1,
    projects: PROJECTS,
    pathname: `/project/${P1}`,
    organizationSlug: "acme",
  });
  const first = (query: string) => searchCommands(entries, query)[0]?.label;
  assert.equal(first("delete project"), "Danger zone");
  assert.equal(first("spend"), "Usage and spend");
  assert.equal(first("api keys"), "API keys");
  assert.equal(first("experiments"), "Experiments");
  assert.equal(first("sdk events"), "SDK events");
  assert.equal(first("retries"), "Self-corrections");
  assert.equal(first("cursor"), "Integrations");
  assert.deepEqual(searchCommands(entries, "zzz"), []);
});

test("an edition's nav items carry their keywords and shortcuts into the rail and ⌘K", () => {
  const organization = consoleNav({
    projectId: undefined,
    organizationSlug: "acme",
    additions: [{ href: "/admin", label: "Admin", keywords: ["operators"] }],
    organizationAdditions: [
      { path: "team", label: "Members", shortcut: "m", keywords: ["invite", "people"] },
      { path: "billing", label: "Billing" },
    ],
  });
  assert.equal(shortcutHref(organization, "m"), "/org/acme/team");
  const project = consoleNav({
    projectId: P1,
    additions: [],
    projectGroups: [
      {
        id: "apis",
        label: "APIs",
        items: [{ path: "models/embeddings", label: "Embeddings", keywords: ["vectors"] }],
      },
    ],
  });
  const entries = commandEntries({
    items: project,
    organizationItems: organization,
    projectId: P1,
    projects: [],
    pathname: `/project/${P1}`,
  });
  const first = (query: string) => searchCommands(entries, query)[0]?.label;
  assert.equal(first("invite"), "Members");
  assert.equal(first("vectors"), "Embeddings");
  assert.equal(first("operators"), "Admin");
  // An item without the new fields works as before.
  const billing = entries.find(({ label }) => label === "Billing");
  assert.deepEqual(billing, {
    id: "/org/acme/billing",
    label: "Billing",
    group: "Organization",
    href: "/org/acme/billing",
  });
});

test("g then a letter jumps to the rail item that owns it, in either rail", () => {
  const project = consoleNav({ projectId: P1, additions: [{ href: "/admin", label: "Admin" }] });
  assert.deepEqual(
    project.map(({ id, shortcut }) => `${id}:${shortcut ?? ""}`),
    [
      "overview:o",
      "health:h",
      "traces:t",
      "catalog:c",
      "intents:i",
      "improvements:",
      "settings:s",
      "edition:/admin:",
    ],
  );
  assert.equal(shortcutHref(project, "T"), `/project/${P1}/traces`);
  assert.equal(shortcutHref(project, "c"), `/project/${P1}/catalogs`);
  assert.equal(shortcutHref(project, "f"), `/project/${P1}/improvement/fixes`);
  assert.equal(shortcutHref(project, "x"), null);
  const organization = consoleNav({
    projectId: undefined,
    organizationSlug: "acme",
    additions: [],
  });
  assert.equal(shortcutHref(organization, "o"), "/org/acme");
  assert.equal(shortcutHref(organization, "s"), "/org/acme/settings");
});

test("visibleOrganizationNav hides only the paths given", () => {
  const nav = [
    { path: "team", label: "Members" },
    { path: "billing", label: "Billing" },
  ];
  assert.deepEqual(visibleOrganizationNav(nav, []), nav);
  assert.deepEqual(visibleOrganizationNav(nav, ["billing"]), [nav[0]]);
  assert.deepEqual(visibleOrganizationNav(nav, ["other"]), nav);
});

test("the stage spine is off unless asked for: the rail is today's", () => {
  assert.deepEqual(
    consoleNav({ projectId: P1, additions: [], stageSpine: false }),
    consoleNav({ projectId: P1, additions: [] }),
  );
  assert.equal(
    consoleNav({ projectId: P1, additions: [] }).some(({ id }) => id === "ship"),
    false,
  );
});

test("the stage spine groups the rail into Monitor, Insights, Improve and Ship, then setup", () => {
  const items = consoleNav({
    projectId: P1,
    additions: [],
    stageSpine: true,
    projectGroups: [{ id: "apis", label: "APIs", items: [{ path: "models/x", label: "X" }] }],
  });
  assert.deepEqual(
    items.map(({ id, section, sectionLabel }) => `${id}|${section ?? ""}|${sectionLabel ?? ""}`),
    [
      "overview|group:monitor|Monitor",
      "health|group:monitor|",
      "traces|group:monitor|",
      "tasks|group:insights|Insights",
      "intents|group:insights|",
      "improvements|group:improve|Improve",
      "ship|group:ship|Ship",
      "project-models/x|group:apis|APIs",
      "catalog|settings|",
      "settings|settings|",
    ],
  );
  const ship = items.find(({ id }) => id === "ship");
  assert.equal(ship?.href, `/project/${P1}/ship`, "Ship is the one new page");
  assert.equal(activeNavItemId(`/project/${P1}/ship`, items), "ship");
  assert.equal(shortcutHref(items, "l"), `/project/${P1}/ship`);
  // Tasks is a top-level page under Insights; Agent health keeps its Summary and Self-corrections.
  const tasks = items.find(({ id }) => id === "tasks");
  assert.equal(tasks?.href, `/project/${P1}/tasks`);
  assert.equal(activeNavItemId(`/project/${P1}/tasks/book-flight`, items), "tasks");
  assert.equal(shortcutHref(items, "w"), `/project/${P1}/tasks`);
  assert.deepEqual(
    items.find(({ id }) => id === "health")?.children?.map(({ id }) => id),
    ["health-summary", "health-self-corrections"],
  );
  // Agent health is lit as one item, wherever inside it the reader is.
  assert.equal(activeNavItemId(`/project/${P1}/health`, items), "health");
  assert.equal(activeNavItemId(`/project/${P1}/health/self-corrections`, items), "health");
  // Tasks has absorbed the Agent health Tasks pages.
  assert.equal(activeNavItemId(`/project/${P1}/health/tasks`, items), "tasks");
  assert.equal(activeNavItemId(`/project/${P1}/health/tasks/sessions/s-1`, items), "tasks");
  assert.equal(activeNavItemId(`/project/${P1}/improvement/tool-explorer`, items), "tasks");
  const hrefs = commandEntries({
    items,
    projectId: P1,
    projects: PROJECTS,
    pathname: `/project/${P1}`,
  }).map((entry) => entry.href);
  assert.ok(hrefs.includes(`/project/${P1}/ship`), "⌘K reaches Ship");
});

test("outside a project the stage spine changes nothing", () => {
  assert.deepEqual(
    consoleNav({ projectId: undefined, organizationSlug: "acme", additions: [], stageSpine: true }),
    consoleNav({ projectId: undefined, organizationSlug: "acme", additions: [] }),
  );
});
