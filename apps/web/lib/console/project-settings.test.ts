import assert from "node:assert/strict";
import { test } from "node:test";
import { renameProject } from "./project-settings";

const P1 = "11111111-1111-4111-8111-111111111111";

type Role = "admin" | "member";

/** The reader: admin of P1's organization, member of P2's; any other id is an organization they are not in. */
const P2 = "22222222-2222-4222-8222-222222222222";
const scopes: Record<string, { project: { id: string }; role: Role }> = {
  [P1]: { project: { id: P1 }, role: "admin" },
  [P2]: { project: { id: P2 }, role: "member" },
};

function deps(signedIn = true, roles: Record<string, Role> = {}) {
  const updates: [string, string][] = [];
  return {
    updates,
    deps: {
      scope: async (id: string) => {
        const scope = signedIn ? scopes[id] : undefined;
        return scope ? { ...scope, role: roles[id] ?? scope.role } : null;
      },
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
  const noSession = deps(false);
  assert.equal((await renameProject(P1, "X", noSession.deps)).ok, false);
  assert.deepEqual(noSession.updates, []);
});

test("a project of a non-active organization is renamed by an admin there, never by a member", async () => {
  const asAdmin = deps(true, { [P2]: "admin" });
  assert.deepEqual(await renameProject(P2, "Other", asAdmin.deps), { ok: true, name: "Other" });
  assert.deepEqual(asAdmin.updates, [[P2, "Other"]]);
  const asMember = deps();
  assert.equal((await renameProject(P2, "Other", asMember.deps)).ok, false);
  assert.deepEqual(asMember.updates, []);
});

test("an empty or overlong name is refused", async () => {
  const { updates, deps: d } = deps();
  assert.equal((await renameProject(P1, "   ", d)).ok, false);
  assert.equal((await renameProject(P1, "x".repeat(61), d)).ok, false);
  assert.deepEqual(updates, []);
});
