import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActingAs } from "@/lib/contracts/session";
import { SUPPORT_SESSION_RESTRICTED_MESSAGE } from "@/lib/platform/api-key-actions";
import { deleteConsoleProject } from "./delete-project";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";

const P3 = "33333333-3333-4333-8333-333333333333";

/** The reader's organizations: Acme (active) with P1 and P2, Beta (not active) with P3 alone. */
const organizations = [
  {
    slug: "acme",
    projects: [
      { id: P1, name: "One" },
      { id: P2, name: "Two" },
    ],
  },
  { slug: "beta", projects: [{ id: P3, name: "Three" }] },
];

function deps(projects = organizations[0].projects, actingAs: ActingAs = null, signedIn = true) {
  const deleted: string[] = [];
  const orgs = [{ ...organizations[0], projects }, organizations[1]];
  return {
    deleted,
    deps: {
      scope: async (id: string) => {
        const organization = signedIn
          ? orgs.find((o) => o.projects.some((p) => p.id === id))
          : undefined;
        const project = organization?.projects.find((p) => p.id === id);
        return organization && project
          ? { organizationSlug: organization.slug, project, projects: organization.projects }
          : null;
      },
      actingAs: async () => actingAs,
      deleteProject: async (id: string) => {
        deleted.push(id);
      },
    },
  };
}

test("the typed name must match; the next page is another project's Dashboards, as upstream", async () => {
  const { deleted, deps: d } = deps();
  assert.deepEqual(await deleteConsoleProject(P1, " One ", d), {
    ok: true,
    next: `/project/${P2}/dashboards`,
  });
  assert.deepEqual(deleted, [P1]);
});

test("deleting the last project goes to the projects page", async () => {
  const { deps: d } = deps([{ id: P1, name: "One" }]);
  assert.deepEqual(await deleteConsoleProject(P1, "One", d), { ok: true, next: "/org/acme" });
});

test("a wrong name, a project of an organization the reader is not in, or no session deletes nothing", async () => {
  const { deleted, deps: d } = deps();
  assert.equal((await deleteConsoleProject(P1, "Two", d)).ok, false);
  assert.equal(
    (await deleteConsoleProject("44444444-4444-4444-8444-444444444444", "One", d)).ok,
    false,
  );
  const signedOut = deps(undefined, null, false);
  assert.equal((await deleteConsoleProject(P1, "One", signedOut.deps)).ok, false);
  assert.deepEqual([...deleted, ...signedOut.deleted], []);
});

test("a project of a non-active organization is deleted, and the next page is in its own organization", async () => {
  const { deleted, deps: d } = deps();
  assert.deepEqual(await deleteConsoleProject(P3, "Three", d), { ok: true, next: "/org/beta" });
  assert.deepEqual(deleted, [P3]);
});

test("no project is deleted in any support session, editable included", async () => {
  const { deleted, deps: d } = deps(undefined, {
    kind: "organization",
    targetId: "org",
    readOnly: false,
  });
  assert.deepEqual(await deleteConsoleProject(P1, "One", d), {
    ok: false,
    error: SUPPORT_SESSION_RESTRICTED_MESSAGE,
  });
  assert.deepEqual(deleted, []);
});

test("a deleted project is reported after the delete; a refused one is not", async () => {
  const order: string[] = [];
  const d = {
    ...deps().deps,
    deleteProject: async (id: string) => {
      order.push(`delete:${id}`);
    },
    projectDeleted: async (id: string) => {
      order.push(`deleted:${id}`);
    },
  };
  await deleteConsoleProject(P1, "One", d);
  assert.deepEqual(order, [`delete:${P1}`, `deleted:${P1}`]);
  order.length = 0;
  await deleteConsoleProject(P1, "Two", d);
  const support: ActingAs = { kind: "organization", targetId: "o1", readOnly: true };
  await deleteConsoleProject(P1, "One", { ...d, actingAs: async () => support });
  assert.deepEqual(order, []);
});
