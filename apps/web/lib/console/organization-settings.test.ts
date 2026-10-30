import assert from "node:assert/strict";
import { test } from "node:test";
import { updateConsoleOrganization } from "./organization-settings";

const ORG = { id: "22222222-2222-4222-8222-222222222222", slug: "acme" };

function deps(role: "admin" | "member" = "admin", conflict = false) {
  const writes: [string, { name: string; slug: string }][] = [];
  return {
    writes,
    deps: {
      scope: async () => ({ organization: ORG, role }),
      update: async (id: string, values: { name: string; slug: string }) => {
        writes.push([id, values]);
        return conflict
          ? ({ ok: false, reason: "slug_conflict" } as const)
          : ({ ok: true } as const);
      },
    },
  };
}

test("an admin renames the session organization and normalizes the slug", async () => {
  const { writes, deps: d } = deps();
  assert.deepEqual(
    await updateConsoleOrganization("acme", { name: " Acme Inc ", slug: "Acme Inc" }, d),
    {
      ok: true,
      name: "Acme Inc",
      slug: "acme-inc",
    },
  );
  assert.deepEqual(writes, [[ORG.id, { name: "Acme Inc", slug: "acme-inc" }]]);
});

test("another organization, a member or a bad name writes nothing", async () => {
  const other = deps();
  assert.equal(
    (await updateConsoleOrganization("other", { name: "X", slug: "x" }, other.deps)).ok,
    false,
  );
  const member = deps("member");
  assert.equal(
    (await updateConsoleOrganization("acme", { name: "X", slug: "x" }, member.deps)).ok,
    false,
  );
  const blank = deps();
  assert.equal(
    (await updateConsoleOrganization("acme", { name: " ", slug: "x" }, blank.deps)).ok,
    false,
  );
  assert.deepEqual([...other.writes, ...member.writes, ...blank.writes], []);
});

test("a taken slug says so", async () => {
  const { deps: d } = deps("admin", true);
  const result = await updateConsoleOrganization("acme", { name: "Acme", slug: "taken" }, d);
  assert.deepEqual(result, { ok: false, error: "That address is taken. Pick another one." });
});
