import assert from "node:assert/strict";
import { test } from "node:test";
import { createComposition } from "@/lib/composition/ports";
import {
  activeNavItemId,
  consoleNav,
  entryHref,
  findProject,
  projectIdFromPath,
  projectRoot,
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
    [{ id: "overview", href: `/project/${P1}` }],
  );
});

test("without a project, project-scoped destinations are absent, not disabled", () => {
  assert.deepEqual(consoleNav({ projectId: undefined, additions: [] }), []);
});

test("composition additions follow the core destinations with stable ids", () => {
  const additions = [{ href: "/admin", label: "Admin" }];
  const withProject = consoleNav({ projectId: P1, additions });
  const without = consoleNav({ projectId: undefined, additions });
  assert.deepEqual(
    withProject.map(({ id, href, label }) => ({ id, href, label })),
    [
      { id: "overview", href: `/project/${P1}`, label: "Overview" },
      { id: "edition:/admin", href: "/admin", label: "Admin" },
    ],
  );
  assert.deepEqual(
    without.map(({ id }) => id),
    ["edition:/admin"],
  );
});

test("the OSS composition adds no destination", () => {
  const items = consoleNav({ projectId: P1, additions: createComposition("oss").nav });
  assert.deepEqual(
    items.map(({ id }) => id),
    ["overview"],
  );
});

test("the active item matches exact index pages and nested paths", () => {
  const items = consoleNav({ projectId: P1, additions: [{ href: "/admin", label: "Admin" }] });
  assert.equal(activeNavItemId(`/project/${P1}`, items), "overview");
  assert.equal(activeNavItemId(`/project/${P1}/settings`, items), null);
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

test("the entry goes to the first project, or nowhere when there is none", () => {
  assert.equal(entryHref(PROJECTS), `/project/${P1}`);
  assert.equal(entryHref([]), null);
});
