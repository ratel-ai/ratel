import assert from "node:assert/strict";
import { test } from "node:test";
import { createComposition } from "@/lib/composition/ports";
import {
  activeNavItemId,
  commandEntries,
  consoleNav,
  entryHref,
  findProject,
  organizationRoot,
  organizationSlugFromPath,
  projectIdFromPath,
  projectRoot,
  shortcutHref,
  switchProjectHref,
} from "./navigation";

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
      { id: "traces", href: `/project/${P1}/traces` },
      { id: "catalog", href: `/project/${P1}/catalogs` },
      { id: "settings", href: `/project/${P1}/settings` },
    ],
  );
  const catalog = items.find(({ id }) => id === "catalog");
  assert.deepEqual(
    catalog?.children?.map(({ id, href }) => ({ id, href })),
    [
      { id: "catalog-tools", href: `/project/${P1}/catalogs/tools` },
      { id: "catalog-skills", href: `/project/${P1}/catalogs/skills` },
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
      { id: "org-settings", href: "/org/acme/settings" },
    ],
  );
  assert.equal(activeNavItemId("/org/acme", items), "projects");
  assert.equal(activeNavItemId("/org/acme/settings", items), "org-settings");
  // Inside a project the rail is the project's, even when the organization is known.
  assert.deepEqual(
    consoleNav({ projectId: P1, organizationSlug: "acme", additions: [] }).map(({ id }) => id),
    ["overview", "traces", "catalog", "settings"],
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
  assert.equal(withProject.length, 5);
  assert.deepEqual(
    without.map(({ id }) => id),
    ["edition:/admin"],
  );
});

test("the OSS composition adds no destination", () => {
  const items = consoleNav({ projectId: P1, additions: createComposition("oss").nav });
  assert.deepEqual(
    items.map(({ id }) => id),
    ["overview", "traces", "catalog", "settings"],
  );
});

test("Settings sits in a section of its own in both rails, the edition's items in another", () => {
  const sectionsOf = (items: ReturnType<typeof consoleNav>) =>
    items.map(({ id, section }) => `${section ?? "main"}:${id}`);
  assert.deepEqual(
    sectionsOf(consoleNav({ projectId: P1, additions: [{ href: "/admin", label: "Admin" }] })),
    ["main:overview", "main:traces", "main:catalog", "settings:settings", "edition:edition:/admin"],
  );
  assert.deepEqual(
    sectionsOf(consoleNav({ projectId: undefined, organizationSlug: "acme", additions: [] })),
    ["main:projects", "settings:org-settings"],
  );
});

test("the active item matches exact index pages and nested paths", () => {
  const items = consoleNav({ projectId: P1, additions: [{ href: "/admin", label: "Admin" }] });
  assert.equal(activeNavItemId(`/project/${P1}`, items), "overview");
  assert.equal(activeNavItemId(`/project/${P1}/settings`, items), "settings");
  assert.equal(activeNavItemId(`/project/${P1}/settings/general`, items), "settings");
  assert.equal(activeNavItemId(`/project/${P1}/traces/abc`, items), "traces");
  assert.equal(activeNavItemId(`/project/${P1}/catalogs`, items), "catalog");
  assert.equal(activeNavItemId(`/project/${P1}/catalogs/tools`, items), "catalog-tools");
  assert.equal(activeNavItemId(`/project/${P1}/catalogs/skills/x`, items), "catalog-skills");
  assert.equal(activeNavItemId(`/project/${P1}/unknown`, items), null);
  assert.equal(activeNavItemId("/admin", items), "edition:/admin");
  assert.equal(activeNavItemId("/admin/users", items), "edition:/admin");
  assert.equal(activeNavItemId("/administer", items), null);
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

test("the entry goes to the first project, else the organization's projects page", () => {
  assert.equal(entryHref(PROJECTS, "acme"), `/project/${P1}`);
  assert.equal(entryHref([], "acme"), "/org/acme");
  assert.equal(entryHref([], undefined), null);
});

test("the command menu lists the rail's destinations, then every project", () => {
  const entries = commandEntries({
    items: consoleNav({ projectId: P1, additions: [{ href: "/admin", label: "Admin" }] }),
    projects: PROJECTS,
    pathname: `/project/${P1}/traces`,
    organizationSlug: "acme",
  });
  assert.deepEqual(
    entries.map(({ label, group, href }) => `${group}|${label}|${href}`),
    [
      `Pages|Overview|/project/${P1}`,
      `Pages|Traces|/project/${P1}/traces`,
      `Pages|Catalog|/project/${P1}/catalogs`,
      `Pages|Tools|/project/${P1}/catalogs/tools`,
      `Pages|Skills|/project/${P1}/catalogs/skills`,
      `Pages|Settings|/project/${P1}/settings`,
      "Pages|Admin|/admin",
      `Projects|One|/project/${P1}/traces`,
      `Projects|Two|/project/${P2}/traces`,
      "Projects|All projects|/org/acme",
      "Projects|New project|/org/acme?new=1",
    ],
  );
  assert.equal(new Set(entries.map(({ id }) => id)).size, entries.length);
});

test("g then a letter jumps to the rail item that owns it, in either rail", () => {
  const project = consoleNav({ projectId: P1, additions: [{ href: "/admin", label: "Admin" }] });
  assert.deepEqual(
    project.map(({ id, shortcut }) => `${id}:${shortcut ?? ""}`),
    ["overview:o", "traces:t", "catalog:c", "settings:s", "edition:/admin:"],
  );
  assert.equal(shortcutHref(project, "T"), `/project/${P1}/traces`);
  assert.equal(shortcutHref(project, "c"), `/project/${P1}/catalogs`);
  assert.equal(shortcutHref(project, "x"), null);
  const organization = consoleNav({
    projectId: undefined,
    organizationSlug: "acme",
    additions: [],
  });
  assert.equal(shortcutHref(organization, "o"), "/org/acme");
  assert.equal(shortcutHref(organization, "s"), "/org/acme/settings");
});
