import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteConsoleProject } from "./delete-project";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";

function deps(
  projects = [
    { id: P1, name: "One" },
    { id: P2, name: "Two" },
  ],
) {
  const deleted: string[] = [];
  return {
    deleted,
    deps: {
      session: async () => ({ organizationSlug: "acme", projects }),
      deleteProject: async (id: string) => {
        deleted.push(id);
      },
    },
  };
}

test("the typed name must match; the next page is another project", async () => {
  const { deleted, deps: d } = deps();
  assert.deepEqual(await deleteConsoleProject(P1, " One ", d), {
    ok: true,
    next: `/project/${P2}`,
  });
  assert.deepEqual(deleted, [P1]);
});

test("deleting the last project goes to the projects page", async () => {
  const { deps: d } = deps([{ id: P1, name: "One" }]);
  assert.deepEqual(await deleteConsoleProject(P1, "One", d), { ok: true, next: "/org/acme" });
});

test("a wrong name or another organization's project deletes nothing", async () => {
  const { deleted, deps: d } = deps();
  assert.equal((await deleteConsoleProject(P1, "Two", d)).ok, false);
  assert.equal(
    (await deleteConsoleProject("33333333-3333-4333-8333-333333333333", "One", d)).ok,
    false,
  );
  assert.deepEqual(deleted, []);
});
