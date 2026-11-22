import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { createDrizzleConsentStore } from "../adapters/drizzle-store";

/**
 * RC-1123: the training opt-in over Postgres. Two projects of one
 * organization: a grant of project A is never read, returned or withdrawn
 * through project B.
 */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "33333333-3333-4333-8333-333333333333";

type TestDb = Parameters<typeof createDrizzleConsentStore>[0];

test("a grant holds the Clerk id, the time and the text version, and a second grant returns the first", async () => {
  const { client, db } = await seeded();
  try {
    const store = createDrizzleConsentStore(db);
    const before = Date.now();
    const first = await store.giveConsent(PROJECT_A, "user_admin", "v1");
    assert.equal(first.created, true);
    assert.equal(first.consent.projectId, PROJECT_A);
    assert.equal(first.consent.givenBy, "user_admin");
    assert.equal(first.consent.textVersion, "v1");
    assert.ok(first.consent.givenAt.getTime() >= before - 60_000);
    assert.equal(first.consent.withdrawnAt, null);

    const second = await store.giveConsent(PROJECT_A, "user_other", "v1");
    assert.equal(second.created, false);
    assert.equal(second.consent.id, first.consent.id);
    assert.equal(second.consent.givenBy, "user_admin");
  } finally {
    await client.close();
  }
});

test("project B cannot read or withdraw the grant of project A", async () => {
  const { client, db } = await seeded();
  try {
    const store = createDrizzleConsentStore(db);
    await store.giveConsent(PROJECT_A, "user_admin", "v1");
    assert.equal(await store.getActiveConsent(PROJECT_B), null);
    assert.equal(await store.withdrawConsent(PROJECT_B, "user_admin"), null);
    assert.equal((await store.getActiveConsent(PROJECT_A))?.projectId, PROJECT_A);
  } finally {
    await client.close();
  }
});

test("a withdrawal stamps who and when, keeps the row, and a new grant is a new row", async () => {
  const { client, db } = await seeded();
  try {
    const store = createDrizzleConsentStore(db);
    const { consent } = await store.giveConsent(PROJECT_A, "user_admin", "v1");
    const withdrawn = await store.withdrawConsent(PROJECT_A, "user_withdrawer");
    assert.equal(withdrawn?.id, consent.id);
    assert.equal(withdrawn?.withdrawnBy, "user_withdrawer");
    assert.ok(withdrawn?.withdrawnAt instanceof Date);
    assert.equal(await store.getActiveConsent(PROJECT_A), null);
    assert.equal(await store.withdrawConsent(PROJECT_A, "user_withdrawer"), null);

    const again = await store.giveConsent(PROJECT_A, "user_admin", "v2");
    assert.equal(again.created, true);
    assert.notEqual(again.consent.id, consent.id);
    const { rows } = await client.query<{ n: number }>(
      `select count(*)::int as n from fine_tuning_consents where project_id = '${PROJECT_A}'`,
    );
    assert.equal(rows[0]?.n, 2);
  } finally {
    await client.close();
  }
});

async function seeded(): Promise<{ client: PGlite; db: TestDb }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT_A}', '${ORGANIZATION_ID}', 'A', 'a'),
      ('${PROJECT_B}', '${ORGANIZATION_ID}', 'B', 'b');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as TestDb };
}
