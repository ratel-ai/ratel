import assert from "node:assert/strict";
import { test } from "node:test";
import { renameProject } from "./project-settings";

const P1 = "11111111-1111-4111-8111-111111111111";

function deps(projects: { id: string; name: string }[] | null = [{ id: P1, name: "One" }]) {
  const updates: [string, string][] = [];
  return {
    updates,
    deps: {
      projects: async () => projects,
      updateProjectName: async (id: string, name: string) => {
        updates.push([id, name]);
      },
    },
  };
}

test("a project of the organization is renamed with the trimmed name", async () => {
  const { updates, deps: d } = deps();
  assert.deepEqual(await renameProject(P1, "  New name ", d), { ok: true, name: "New name" });
  assert.deepEqual(updates, [[P1, "New name"]]);
});

test("a project outside the organization is never written", async () => {
  const { updates, deps: d } = deps();
  const result = await renameProject("33333333-3333-4333-8333-333333333333", "X", d);
  assert.equal(result.ok, false);
  assert.deepEqual(updates, []);
  const noSession = deps(null);
  assert.equal((await renameProject(P1, "X", noSession.deps)).ok, false);
  assert.deepEqual(noSession.updates, []);
});

test("an empty or overlong name is refused", async () => {
  const { updates, deps: d } = deps();
  assert.equal((await renameProject(P1, "   ", d)).ok, false);
  assert.equal((await renameProject(P1, "x".repeat(61), d)).ok, false);
  assert.deepEqual(updates, []);
});
