import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { type ImportDeps, importSkills } from "@/lib/catalog/import";
import {
  countSkills,
  createSkill,
  getActiveSkillByName,
  getProjectCatalogVersion,
  type SkillsDb,
  setSkillStatus,
  updateSkill,
} from "@/lib/catalog/queries";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";

/**
 * The import engine against a real in-process Postgres: the actual unique index,
 * version CAS, and catalog-ETag recompute — plus re-import idempotence.
 */

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
// Owned (ADR-0030): the organization is the entitlements port's limit view, not a plan row.
const ORG = {
  id: ORG_ID,
  limitOverrides: null,
} as Parameters<typeof importSkills>[1];

async function setup(): Promise<{ db: SkillsDb; deps: ImportDeps }> {
  const client = await createMigratedPGlite();
  await client.exec(
    `insert into organizations (id, name, slug) values ('${ORG_ID}', 'Acme', 'acme');
     insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORG_ID}', 'P', 'p');`,
  );
  const db = drizzle(client, { schema }) as unknown as SkillsDb;
  const deps: ImportDeps = {
    getActiveSkillByName: (p, n) => getActiveSkillByName(p, n, db),
    createSkill: (row) => createSkill(row, db),
    updateSkill: (p, id, v, patch) => updateSkill(p, id, v, patch, db),
    countSkills: (p) => countSkills(p, db),
  };
  return { db, deps };
}

const SKILLS = [
  {
    name: "deploy-checklist",
    description: "How to deploy safely.",
    body: "# Deploy",
    tags: ["ops"],
    tools: [],
    metadata: {},
    status: "published" as const,
  },
  {
    name: "sql-writer",
    description: "Write SQL.",
    body: "# SQL",
    tags: [],
    tools: [],
    metadata: {},
    status: "draft" as const,
  },
];

test("import → re-import is idempotent; edits update; ETag recomputes for published rows", async () => {
  const { db, deps } = await setup();

  const first = await importSkills(PROJECT_ID, ORG, SKILLS, deps);
  assert.deepEqual(first, {
    ok: true,
    created: ["deploy-checklist", "sql-writer"],
    updated: [],
    unchanged: [],
  });
  const etagAfterCreate = await getProjectCatalogVersion(PROJECT_ID, db);
  assert.notEqual(etagAfterCreate, null); // published create recomputed the ETag

  const second = await importSkills(PROJECT_ID, ORG, SKILLS, deps);
  assert.equal(second.ok, true);
  if (!second.ok) throw new Error("unreachable");
  assert.deepEqual(second.unchanged.sort(), ["deploy-checklist", "sql-writer"]);
  assert.equal(await getProjectCatalogVersion(PROJECT_ID, db), etagAfterCreate);

  const edited = await importSkills(
    PROJECT_ID,
    ORG,
    [{ ...SKILLS[0]!, description: "How to deploy VERY safely." }],
    deps,
  );
  assert.equal(edited.ok, true);
  if (!edited.ok) throw new Error("unreachable");
  assert.deepEqual(edited.updated, ["deploy-checklist"]);
  // The published row changed → the stored catalog ETag moved.
  assert.notEqual(await getProjectCatalogVersion(PROJECT_ID, db), etagAfterCreate);
});

test("an archived row frees its name: import creates a fresh skill", async () => {
  const { db, deps } = await setup();
  const created = await createSkill(
    { projectId: PROJECT_ID, name: "reborn", description: "v1", body: "b" },
    db,
  );
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("unreachable");
  await setSkillStatus(PROJECT_ID, created.skill.id, "archived", {}, db);

  const outcome = await importSkills(
    PROJECT_ID,
    ORG,
    [
      {
        name: "reborn",
        description: "v2",
        body: "b",
        tags: [],
        tools: [],
        metadata: {},
        status: "draft" as const,
      },
    ],
    deps,
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) throw new Error("unreachable");
  assert.deepEqual(outcome.created, ["reborn"]);
  const live = await getActiveSkillByName(PROJECT_ID, "reborn", db);
  assert.equal(live?.description, "v2");
  assert.notEqual(live?.id, created.skill.id);
});

test("import creates, edits, and clears searchableDescription", async () => {
  const { db, deps } = await setup();
  const base = {
    ...SKILLS[0]!,
    searchableDescription: "release canary rollback",
  };
  assert.equal((await importSkills(PROJECT_ID, ORG, [base], deps)).ok, true);
  let row = await getActiveSkillByName(PROJECT_ID, base.name, db);
  assert.equal(row?.searchableDescription, "release canary rollback");

  const edited = await importSkills(
    PROJECT_ID,
    ORG,
    [{ ...base, searchableDescription: "deploy production safely" }],
    deps,
  );
  assert.deepEqual(edited, { ok: true, created: [], updated: [base.name], unchanged: [] });

  const cleared = await importSkills(
    PROJECT_ID,
    ORG,
    [{ ...base, searchableDescription: null }],
    deps,
  );
  assert.deepEqual(cleared, { ok: true, created: [], updated: [base.name], unchanged: [] });
  row = await getActiveSkillByName(PROJECT_ID, base.name, db);
  assert.equal(row?.searchableDescription, null);
});
