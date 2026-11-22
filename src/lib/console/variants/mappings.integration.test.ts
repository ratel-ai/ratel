import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  DENIED,
  removeVariantMappingAction,
  saveVariantMappingAction,
  type VariantMappingActionDeps,
} from "@/lib/console/variants/mapping-actions";
import {
  listVariantMappings,
  MAX_VARIANT_MAPPINGS,
  removeVariantMapping,
  saveVariantMapping,
  type VariantMappingsDb,
} from "@/lib/ingest/variants/mappings-store";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";

/** RC-869: a project member lists, adds and removes the project's variant attribute mappings. */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const MEMBER = { userId: "user-1", externalId: "clerk-1" };

test("a member saves a mapping, saves the same key again, and removes it", async () => {
  const { client, db, deps, events } = await setup();

  assert.deepEqual(
    await saveVariantMappingAction(
      PROJECT_ID,
      { attributeKey: " app.variant ", experiment: "checkout" },
      deps,
    ),
    { ok: true },
  );
  assert.deepEqual(
    await saveVariantMappingAction(
      PROJECT_ID,
      { attributeKey: "app.variant", experiment: "checkout-model" },
      deps,
    ),
    { ok: true },
  );
  const [mapping] = await listVariantMappings(PROJECT_ID, db);
  assert.equal(mapping.attributeKey, "app.variant");
  assert.equal(mapping.experiment, "checkout-model");
  assert.equal((await listVariantMappings(PROJECT_ID, db)).length, 1);

  assert.deepEqual(await removeVariantMappingAction(PROJECT_ID, mapping.id, deps), { ok: true });
  assert.deepEqual(await listVariantMappings(PROJECT_ID, db), []);
  assert.deepEqual(events, [
    "variant_mapping_saved",
    "variant_mapping_saved",
    "variant_mapping_removed",
  ]);
  await client.close();
});

test("no session, a non-member, or the flag off: nothing changes", async () => {
  const { client, db, deps } = await setup();
  const input = { attributeKey: "app.variant", experiment: "x" };

  assert.deepEqual(
    await saveVariantMappingAction(PROJECT_ID, input, { ...deps, getActor: async () => null }),
    DENIED,
  );
  assert.deepEqual(await saveVariantMappingAction(OTHER_PROJECT_ID, input, deps), DENIED);
  assert.deepEqual(
    await saveVariantMappingAction(PROJECT_ID, input, { ...deps, isEnabled: async () => false }),
    DENIED,
  );
  assert.deepEqual(await listVariantMappings(PROJECT_ID, db), []);
  assert.deepEqual(await listVariantMappings(OTHER_PROJECT_ID, db), []);
  await client.close();
});

test("a member cannot remove another project's mapping through their own project", async () => {
  const { client, db, deps } = await setup();
  await saveVariantMapping(
    OTHER_PROJECT_ID,
    { attributeKey: "app.variant", experiment: "x" },
    "someone",
    db,
  );
  const [other] = await listVariantMappings(OTHER_PROJECT_ID, db);

  assert.deepEqual(await removeVariantMappingAction(PROJECT_ID, other.id, deps), DENIED);
  assert.equal((await listVariantMappings(OTHER_PROJECT_ID, db)).length, 1);
  await client.close();
});

test("an invalid mapping is refused with its reason", async () => {
  const { client, deps } = await setup();
  const result = await saveVariantMappingAction(
    PROJECT_ID,
    { attributeKey: "ratel.variant.name", experiment: "x" },
    deps,
  );
  assert.equal(result.ok, false);
  await client.close();
});

test("a project holds at most MAX_VARIANT_MAPPINGS mappings, and a saved key can still change", async () => {
  const { client, db } = await setup();
  for (let index = 0; index < MAX_VARIANT_MAPPINGS; index += 1) {
    assert.equal(
      await saveVariantMapping(PROJECT_ID, { attributeKey: `k${index}`, experiment: "x" }, "u", db),
      "saved",
    );
  }
  assert.equal(
    await saveVariantMapping(PROJECT_ID, { attributeKey: "one-more", experiment: "x" }, "u", db),
    "full",
  );
  assert.equal(
    await saveVariantMapping(PROJECT_ID, { attributeKey: "k0", experiment: "y" }, "u", db),
    "saved",
  );
  assert.equal(
    await removeVariantMapping(PROJECT_ID, "00000000-0000-4000-8000-000000000000", db),
    false,
  );
  await client.close();
});

async function setup(): Promise<{
  client: PGlite;
  db: VariantMappingsDb;
  deps: VariantMappingActionDeps;
  events: string[];
}> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent'),
      ('${OTHER_PROJECT_ID}', '${ORGANIZATION_ID}', 'Other', 'other');
  `);
  const db = drizzle(client, { schema }) as unknown as VariantMappingsDb;
  const events: string[] = [];
  const deps: VariantMappingActionDeps = {
    getActor: async () => MEMBER,
    // The member belongs to PROJECT_ID only.
    findScope: async (projectId, userId) =>
      projectId === PROJECT_ID && userId === MEMBER.userId
        ? { projectId, organizationId: ORGANIZATION_ID, flagOrganization: ORGANIZATION_ID }
        : null,
    isEnabled: async () => true,
    save: (projectId, mapping, createdBy) => saveVariantMapping(projectId, mapping, createdBy, db),
    remove: (projectId, mappingId) => removeVariantMapping(projectId, mappingId, db),
    track: async (event) => {
      events.push(event);
    },
    revalidate: () => {},
    logError: (message, err) => {
      throw new Error(`${message}: ${String(err)}`);
    },
  };
  return { client, db, deps, events };
}
