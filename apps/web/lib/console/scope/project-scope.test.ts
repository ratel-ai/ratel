import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { getProjectById, parseProjectUuid } from "@/lib/platform/projects/queries";

/**
 * The rule the console's project scope applies, run against the same reads it uses: a project
 * is readable when it belongs to the session's organization, and only then. The React cache and
 * `notFound()` wrappers are Next's; the read is what this test covers.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "44444444-4444-4444-8444-444444444444";

type Db = ReturnType<typeof getDb>;

async function scopeOf(projectId: string, organizationId: string, db: Db) {
  const id = parseProjectUuid(projectId);
  if (!id) return null;
  const project = await getProjectById(id, db);
  return project && project.organizationId === organizationId ? project : null;
}

test("a project reads for its own organization and for no other, and a malformed id reads as none", async () => {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme'), ('${OTHER_ORG}', 'Other', 'other');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent'), ('${FOREIGN}', '${OTHER_ORG}', 'Theirs', 'theirs');
  `);
  const db = drizzle(client, { schema }) as unknown as Db;
  assert.equal((await scopeOf(PROJECT, ORG, db))?.id, PROJECT);
  assert.equal(
    await scopeOf(FOREIGN, ORG, db),
    null,
    "another organization's project is not there",
  );
  assert.equal(await scopeOf("not-a-uuid", ORG, db), null);
  await client.close();
});
