import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  ensurePersonalOrganization,
  getLastProjectId,
  type LastProjectDb,
  type OrganizationsDb,
  type SettingsDb,
  setLastProject,
  updateOrganizationSettings,
} from "./queries";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";

test("personal organization provisioning reports only the winning creation", async () => {
  const client = await createMigratedPGlite();
  await client.exec(`insert into users (id, external_id) values ('${USER_ID}', 'user_1')`);
  const db = drizzle(client, { schema }) as unknown as OrganizationsDb;
  const input = {
    userId: USER_ID,
    preferredSlug: "casey",
    fallbackSlug: "casey-user-1",
    name: "Casey",
  };

  const first = await ensurePersonalOrganization(input, db);
  const second = await ensurePersonalOrganization(input, db);

  assert.equal(first.created, true);
  assert.equal(first.role, "admin");
  assert.equal(second.created, false);
  assert.equal(second.organization.id, first.organization.id);
});

test("a taken friendly slug falls back to the per-user slug", async () => {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Casey Inc', 'casey');
    insert into users (id, external_id) values ('${USER_ID}', 'user_1');
  `);
  const db = drizzle(client, { schema }) as unknown as OrganizationsDb;

  const result = await ensurePersonalOrganization(
    { userId: USER_ID, preferredSlug: "casey", fallbackSlug: "casey-user-1", name: "Casey" },
    db,
  );

  assert.equal(result.organization.slug, "casey-user-1");
});

test("last project persists and clears when its project is deleted", async () => {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into users (id, external_id) values ('${USER_ID}', 'user_123');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Support', 'support');
  `);
  const db = drizzle(client, { schema }) as unknown as LastProjectDb;

  assert.equal(await getLastProjectId(USER_ID, db), null);
  await setLastProject(USER_ID, PROJECT_ID, db);
  assert.equal(await getLastProjectId(USER_ID, db), PROJECT_ID);
  await client.exec(`delete from projects where id = '${PROJECT_ID}'`);
  assert.equal(await getLastProjectId(USER_ID, db), null);
});

test("organization settings update name and slug together and report a claimed slug", async () => {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values
      ('${ORGANIZATION_ID}', 'Acme', 'acme'),
      ('44444444-4444-4444-8444-444444444444', 'Other', 'claimed');
  `);
  const db = drizzle(client, { schema });

  assert.deepEqual(
    await updateOrganizationSettings(
      ORGANIZATION_ID,
      { name: "Acme Labs", slug: "acme-labs" },
      db as unknown as SettingsDb,
    ),
    { ok: true },
  );
  const [row] = await db
    .select({ name: schema.organizations.name, slug: schema.organizations.slug })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, ORGANIZATION_ID));
  assert.deepEqual(row, { name: "Acme Labs", slug: "acme-labs" });

  assert.deepEqual(
    await updateOrganizationSettings(
      ORGANIZATION_ID,
      { name: "Acme Labs", slug: "claimed" },
      db as unknown as SettingsDb,
    ),
    { ok: false, reason: "slug_conflict" },
  );
});

import { eq } from "drizzle-orm";
