import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { hashApiKey } from "@/lib/platform/api-keys";
import type { ExpiredApiKey } from "@/lib/platform/api-keys-observability";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  type ApiKeyDb,
  createApiKey,
  findActiveApiKeyByHash,
  findApiKeyForProject,
  getPrimaryApiKeyForProject,
  getProjectById,
  listApiKeysForProject,
  listProjectsForOrganization,
  type ProjectLookupDb,
  type ProjectSettingsDb,
  parseProjectUuid,
  revokeApiKey,
  updateProjectName,
} from "./queries";

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_PROJECT_ID = "44444444-4444-4444-8444-444444444444";

async function seed() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Support', 'support'),
      ('${OTHER_PROJECT_ID}', '${ORGANIZATION_ID}', 'Billing', 'billing');
  `);
  return { client, db: drizzle(client, { schema }) };
}

const never = async () => {
  assert.fail("expired reporter should not have been called");
};

function key(plaintext: string, over: Partial<schema.NewApiKey> = {}): schema.NewApiKey {
  return {
    projectId: PROJECT_ID,
    keyHash: hashApiKey(plaintext),
    keyPrefix: plaintext.slice(0, 12),
    keyPlaintext: plaintext,
    ...over,
  };
}

test("project lookup rejects malformed ids before querying PostgreSQL", async () => {
  const { db } = await seed();
  assert.equal(parseProjectUuid("_"), null);
  assert.equal(parseProjectUuid(PROJECT_ID.toUpperCase()), PROJECT_ID);
  assert.equal(await getProjectById("_", db as unknown as ProjectLookupDb), null);
  assert.equal(
    (await getProjectById(PROJECT_ID, db as unknown as ProjectLookupDb))?.slug,
    "support",
  );
});

test("project settings rename only the selected project; the organization lists both", async () => {
  const { db } = await seed();
  await updateProjectName(PROJECT_ID, "Support Copilot", db as unknown as ProjectSettingsDb);
  const rows = await listProjectsForOrganization(ORGANIZATION_ID, db as unknown as ProjectLookupDb);
  assert.deepEqual(
    rows.map((p) => [p.id, p.name]),
    [
      [PROJECT_ID, "Support Copilot"],
      [OTHER_PROJECT_ID, "Billing"],
    ],
  );
});

test("a project holds several live keys at once and revoking one leaves the rest working", async () => {
  const { db } = await seed();
  const keys = db as unknown as ApiKeyDb;
  const ci = await createApiKey(key("rtl_ci_aaaaaaaa", { name: "CI" }), keys);
  const staging = await createApiKey(key("rtl_st_bbbbbbbb", { name: "Staging" }), keys);

  assert.deepEqual(
    (await listApiKeysForProject(PROJECT_ID, keys)).map((k) => k.name),
    ["Staging", "CI"],
    "newest first",
  );
  await revokeApiKey(ci.id, keys);
  assert.equal(await findActiveApiKeyByHash(ci.keyHash, never, keys), null);
  assert.equal((await findActiveApiKeyByHash(staging.keyHash, never, keys))?.id, staging.id);
  assert.deepEqual(
    (await listApiKeysForProject(PROJECT_ID, keys)).map((k) => k.name),
    ["Staging"],
  );
});

test("the shared auth path rejects an expired key, reports it once, and keeps a future expiry working", async () => {
  const { db } = await seed();
  const keys = db as unknown as ApiKeyDb;
  const expired = await createApiKey(
    key("rtl_ex_cccccccc", { name: "Old", expiresAt: new Date(Date.now() - 1_000) }),
    keys,
  );
  const live = await createApiKey(
    key("rtl_fu_dddddddd", { expiresAt: new Date(Date.now() + 60_000) }),
    keys,
  );
  const legacy = await createApiKey(key("rtl_lg_eeeeeeee"), keys);

  const reported: ExpiredApiKey[] = [];
  assert.equal(
    await findActiveApiKeyByHash(expired.keyHash, async (k) => void reported.push(k), keys),
    null,
  );
  assert.deepEqual(
    reported.map((r) => r.id),
    [expired.id],
  );
  assert.equal((await findActiveApiKeyByHash(live.keyHash, never, keys))?.id, live.id);
  assert.equal(legacy.expiresAt, null);
  assert.equal((await findActiveApiKeyByHash(legacy.keyHash, never, keys))?.id, legacy.id);
  assert.deepEqual(
    (await listApiKeysForProject(PROJECT_ID, keys)).map((k) => k.name).sort(),
    [null, null, "Old"].sort(),
  );
});

test("the primary key skips expired keys and a project with only expired keys has none", async () => {
  const { db } = await seed();
  const keys = db as unknown as ApiKeyDb;
  const usable = await createApiKey(key("rtl_ok_ffffffff", { name: "Live" }), keys);
  await createApiKey(
    key("rtl_ex_gggggggg", { name: "Old", expiresAt: new Date(Date.now() - 1_000) }),
    keys,
  );
  assert.equal((await getPrimaryApiKeyForProject(PROJECT_ID, keys))?.id, usable.id);

  await createApiKey(
    key("rtl_ex_hhhhhhhh", {
      projectId: OTHER_PROJECT_ID,
      expiresAt: new Date(Date.now() - 1_000),
    }),
    keys,
  );
  assert.equal(await getPrimaryApiKeyForProject(OTHER_PROJECT_ID, keys), null);
});

test("a key is only found through the project that owns it, and malformed ids never reach PostgreSQL", async () => {
  const { db } = await seed();
  const keys = db as unknown as ApiKeyDb;
  const mine = await createApiKey(key("rtl_ci_aaaaaaaa"), keys);
  assert.equal((await findApiKeyForProject(PROJECT_ID, mine.id, keys))?.id, mine.id);
  assert.equal(await findApiKeyForProject(OTHER_PROJECT_ID, mine.id, keys), null);
  assert.equal(await findApiKeyForProject(PROJECT_ID, "not-a-uuid", keys), null);
});
