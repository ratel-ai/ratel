import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "@/lib/contracts/session";
import type { Project } from "@/lib/platform/projects/schema";
import { type ConsoleScopeDeps, loadConsoleScope } from "./shell-data";

const acme = { id: "o-acme", name: "Acme", slug: "acme" };
const beta = { id: "o-beta", name: "Beta", slug: "beta" };
const gamma = { id: "o-gamma", name: "Gamma", slug: "gamma" };
const user = {
  id: "u1",
  externalId: "user_1",
  email: "ada@example.com",
  name: "Ada",
  username: null,
  avatarUrl: null,
};

const project = (id: string, organizationId: string) =>
  ({ id, name: id, organizationId, slug: id, isDemo: false }) as Project;

const rows: Project[] = [
  project("a1", acme.id),
  project("b1", beta.id),
  project("g1", gamma.id),
  project("b2", beta.id),
];

function deps() {
  const reads: string[] = [];
  const d: ConsoleScopeDeps = {
    listProjects: async (id) => {
      reads.push(`one:${id}`);
      return rows.filter((p) => p.organizationId === id);
    },
    listProjectsForOrganizations: async (ids) => {
      reads.push(`many:${ids.join(",")}`);
      return rows.filter((p) => ids.includes(p.organizationId));
    },
    ensureSampleProject: async () => {
      throw new Error("not empty");
    },
  };
  return { reads, d };
}

test("the shell gets every organization the reader belongs to, with their role, and all their projects", async () => {
  const session: Session = {
    user,
    organization: beta,
    role: "member",
    memberships: [
      { organization: acme, role: "admin" },
      { organization: beta, role: "member" },
    ],
  };
  const { reads, d } = deps();
  const scope = await loadConsoleScope(session, d);
  assert.deepEqual(scope.organizations, [
    { ...acme, role: "admin" },
    { ...beta, role: "member" },
  ]);
  assert.deepEqual(
    scope.projects.map((p) => p.id),
    ["b1", "b2"],
    "projects stay the active organization's",
  );
  assert.deepEqual(
    scope.memberProjects.map((p) => p.id),
    ["a1", "b1", "b2"],
    "grouped in membership order; never an organization the reader is not in",
  );
  assert.equal(scope.organizationSlug, "beta");
  assert.deepEqual(reads.sort(), ["many:o-acme", "one:o-beta"]);
});

test("open source: one membership reads its projects once, and the shell's lists match", async () => {
  const session: Session = {
    user,
    organization: acme,
    role: "admin",
    memberships: [{ organization: acme, role: "admin" }],
  };
  const { reads, d } = deps();
  const scope = await loadConsoleScope(session, d);
  assert.deepEqual(reads, ["one:o-acme"]);
  assert.deepEqual(scope.memberProjects, scope.projects);
  assert.deepEqual(scope.organizations, [{ ...acme, role: "admin" }]);
  assert.deepEqual(
    { name: scope.organizationName, slug: scope.organizationSlug, role: scope.role },
    { name: "Acme", slug: "acme", role: "admin" },
  );
});
