import assert from "node:assert/strict";
import { test } from "node:test";
import { type ImportDeps, importSkills, sameContent } from "@/lib/catalog/import";
import type { CreateSkillInput } from "@/lib/catalog/manage";
import type { SkillMutationResult } from "@/lib/catalog/queries";
import type { Skill } from "@/lib/catalog/schema";

/**
 * Unit tests for the import engine's partitioning, content comparison, quota
 * gate, and CAS-retry behavior — all against fake deps (no database). The real
 * unique-index/version semantics are covered by import.integration.test.ts.
 */

const FREE_ORG = {
  id: "org-1",
  limitOverrides: null,
} as Parameters<typeof importSkills>[1];

function skillRow(over: Partial<Skill> & { name: string }): Skill {
  return {
    id: `id-${over.name}`,
    projectId: "p1",
    description: "d",
    searchableDescription: null,
    tags: [],
    tools: [],
    metadata: {},
    body: "b",
    status: "draft",
    version: 1,
    endUserId: null,
    model: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    publishedAt: null,
    ...over,
  } as Skill;
}

function input(over: Partial<CreateSkillInput> & { name: string }): CreateSkillInput {
  return {
    description: "d",
    body: "b",
    tags: [],
    tools: [],
    metadata: {},
    status: "draft",
    ...over,
  } as CreateSkillInput;
}

/** Fake deps over an in-memory map; records mutation calls. */
function makeDeps(existing: Skill[], over: Partial<ImportDeps> = {}) {
  const byName = new Map(existing.map((s) => [s.name, s]));
  const calls: { created: string[]; updated: string[] } = { created: [], updated: [] };
  const deps: ImportDeps = {
    getActiveSkillByName: async (_p, name) => byName.get(name) ?? null,
    createSkill: async (row) => {
      calls.created.push(row.name as string);
      const skill = skillRow({ name: row.name as string });
      byName.set(skill.name, skill);
      return { ok: true, skill };
    },
    updateSkill: async (_p, id, expectedVersion, patch): Promise<SkillMutationResult> => {
      const target = [...byName.values()].find((s) => s.id === id);
      if (!target) return { ok: false, reason: "not_found" };
      if (target.version !== expectedVersion) return { ok: false, reason: "version_conflict" };
      calls.updated.push(target.name);
      Object.assign(target, patch, { version: target.version + 1 });
      return { ok: true, skill: target };
    },
    countSkills: async () => byName.size,
    ...over,
  };
  return { deps, calls, byName };
}

test("partitions created / updated / unchanged by name", async () => {
  const { deps } = makeDeps([
    skillRow({ name: "keep", description: "same", body: "same" }),
    skillRow({ name: "change", description: "old", body: "old" }),
  ]);
  const outcome = await importSkills(
    "p1",
    FREE_ORG,
    [
      input({ name: "keep", description: "same", body: "same" }),
      input({ name: "change", description: "new", body: "new" }),
      input({ name: "fresh" }),
    ],
    deps,
  );
  assert.deepEqual(outcome, {
    ok: true,
    created: ["fresh"],
    updated: ["change"],
    unchanged: ["keep"],
  });
});

test("sameContent: metadata key order is irrelevant, tags/tools order matters", () => {
  const existing = skillRow({
    name: "s",
    tags: ["a", "b"],
    tools: ["t1"],
    metadata: { x: ["1"], y: ["2"] },
  });
  assert.equal(
    sameContent(
      existing,
      input({ name: "s", tags: ["a", "b"], tools: ["t1"], metadata: { y: ["2"], x: ["1"] } }),
    ),
    true,
  );
  assert.equal(
    sameContent(
      existing,
      input({ name: "s", tags: ["b", "a"], tools: ["t1"], metadata: { x: ["1"], y: ["2"] } }),
    ),
    false,
  );
  assert.equal(
    sameContent(
      existing,
      input({ name: "s", tags: ["a", "b"], tools: ["t1"], metadata: { x: ["1"] } }),
    ),
    false,
  );
});

test("existing rows keep their status and endUserId (create-only fields)", async () => {
  const published = skillRow({
    name: "pub",
    status: "published",
    endUserId: "alice",
    description: "old",
  });
  const { deps, byName } = makeDeps([published]);
  const outcome = await importSkills(
    "p1",
    FREE_ORG,
    [input({ name: "pub", description: "new", status: "published", endUserId: "bob" })],
    deps,
  );
  assert.equal(outcome.ok, true);
  const after = byName.get("pub");
  assert.equal(after?.description, "new");
  assert.equal(after?.status, "published");
  assert.equal(after?.endUserId, "alice");
});

test("quota gate is all-or-nothing and counts only creates", async () => {
  // Cap via limitOverrides (OSS defaults are unlimited); simulate a full project
  // by making countSkills return at the cap.
  const cappedOrg = {
    id: "org-1",
    limitOverrides: { maxSkillsPerProject: 1 },
  } as Parameters<typeof importSkills>[1];
  const existing = skillRow({ name: "existing", description: "old" });
  const { deps, calls } = makeDeps([existing], { countSkills: async () => 1 });

  // Updates only: no creates → no quota check → succeeds even when "full".
  const updates = await importSkills(
    "p1",
    cappedOrg,
    [input({ name: "existing", description: "new" })],
    deps,
  );
  assert.equal(updates.ok, true);

  // One create among updates: blocked before ANY write.
  calls.updated.length = 0;
  const blocked = await importSkills(
    "p1",
    cappedOrg,
    [input({ name: "existing", description: "newer" }), input({ name: "fresh" })],
    deps,
  );
  assert.equal(blocked.ok, false);
  if (blocked.ok) throw new Error("unreachable");
  assert.equal(blocked.reason, "quota_exceeded");
  assert.deepEqual(calls.created, []);
  assert.deepEqual(calls.updated, []);
});

test("version conflict: one re-read-and-retry, then gives up with conflict", async () => {
  const target = skillRow({ name: "hot", description: "old", version: 1 });
  const { deps } = makeDeps([target]);
  let attempts = 0;
  deps.updateSkill = async () => {
    attempts += 1;
    return { ok: false, reason: "version_conflict" };
  };
  const outcome = await importSkills(
    "p1",
    FREE_ORG,
    [input({ name: "hot", description: "new" })],
    deps,
  );
  assert.deepEqual(outcome, { ok: false, reason: "conflict" });
  assert.equal(attempts, 2);
});

test("create race (name_conflict) falls through to the update path", async () => {
  const racedRow = skillRow({ name: "raced", description: "old" });
  // racedRow is visible to the default updateSkill (it "exists" in the store), but
  // the overridden lookup hides it until the create attempt loses the race.
  const { deps, calls } = makeDeps([racedRow]);
  let appeared = false;
  deps.getActiveSkillByName = async (_p, name) => (name === "raced" && appeared ? racedRow : null);
  deps.createSkill = async () => {
    appeared = true; // someone else won the insert between pre-scan and create
    return { ok: false, reason: "name_conflict" };
  };
  const outcome = await importSkills(
    "p1",
    FREE_ORG,
    [input({ name: "raced", description: "new" })],
    deps,
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) throw new Error("unreachable");
  assert.deepEqual(outcome.updated, ["raced"]);
  assert.deepEqual(calls.updated, ["raced"]);
});
