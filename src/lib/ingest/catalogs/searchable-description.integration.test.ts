import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import {
  createSkill,
  getProjectCatalogVersion,
  getProjectCatalogVersionV2,
  getPublishedCatalog,
  getPublishedCatalogV2,
  type SkillsDb,
  updateSkill,
} from "@/lib/catalog/queries";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

async function setup(): Promise<SkillsDb> {
  const client = await createMigratedPGlite();
  await client.exec(
    `insert into organizations (id, name, slug) values ('${ORG_ID}', 'Acme', 'acme');
     insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORG_ID}', 'P', 'p');`,
  );
  return drizzle(client, { schema }) as unknown as SkillsDb;
}

test("published searchable-description edits move v2 ETag but leave v1 byte identity stable", async () => {
  const db = await setup();
  const created = await createSkill(
    {
      projectId: PROJECT_ID,
      name: "deploy-checklist",
      description: "Deploy safely.",
      searchableDescription: null,
      body: "# Deploy",
      status: "published",
    },
    db,
  );
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("unreachable");

  const initialV1 = await getProjectCatalogVersion(PROJECT_ID, db);
  const initialV2 = await getProjectCatalogVersionV2(PROJECT_ID, db);
  const initialV1Bytes = JSON.stringify(await getPublishedCatalog(PROJECT_ID, db));
  assert.equal("searchableDescription" in JSON.parse(initialV1Bytes)[0]!, false);
  assert.equal((await getPublishedCatalogV2(PROJECT_ID, db))[0]?.searchableDescription, null);

  const edited = await updateSkill(
    PROJECT_ID,
    created.skill.id,
    created.skill.version,
    { searchableDescription: "release production rollback canary" },
    db,
  );
  assert.equal(edited.ok, true);
  if (!edited.ok) throw new Error("unreachable");
  assert.equal(edited.skill.searchableDescription, "release production rollback canary");
  assert.equal(await getProjectCatalogVersion(PROJECT_ID, db), initialV1);
  assert.equal(JSON.stringify(await getPublishedCatalog(PROJECT_ID, db)), initialV1Bytes);
  assert.notEqual(await getProjectCatalogVersionV2(PROJECT_ID, db), initialV2);

  const cleared = await updateSkill(
    PROJECT_ID,
    created.skill.id,
    edited.skill.version,
    { searchableDescription: null },
    db,
  );
  assert.equal(cleared.ok, true);
  if (!cleared.ok) throw new Error("unreachable");
  assert.equal(cleared.skill.searchableDescription, null);
  assert.equal(await getProjectCatalogVersionV2(PROJECT_ID, db), initialV2);
});
