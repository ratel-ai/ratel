import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { MIGRATIONS_DIR } from "@/lib/platform/db/test-support";
import { createDrizzleCaseStore } from "../adapters/drizzle-case-store";
import { createDrizzleExperimentStore } from "../adapters/drizzle-experiment-store";
import { currentVersion } from "../domain/case";
import { ORGANIZATION_ID, PROJECT_ID } from "./support";

/**
 * Migration 0067 (decision `rows-count-at-once`): a row version has no state. A draft becomes a
 * version that counts, and the newest version of a row counts.
 */
const MIGRATION = "0067_rows_count_at_once.sql";
const EVAL = "e0000000-0000-4000-8000-000000000000";
const BOTH = "a0000000-0000-4000-8000-000000000000";
const DRAFT = "b0000000-0000-4000-8000-000000000000";

test("a draft becomes the version that counts, and the older versions stay", async () => {
  const { client, db } = await migrated();
  const cases = createDrizzleCaseStore(db);
  const both = await cases.get(PROJECT_ID, BOTH);
  assert.deepEqual(
    both?.versions.map(({ number, input }) => [number, input]),
    [
      [2, "edited"],
      [1, "first"],
    ],
  );
  assert.equal(both && currentVersion(both)?.number, 2);
  const draft = await cases.get(PROJECT_ID, DRAFT);
  assert.equal(draft && currentVersion(draft)?.input, "draft only");
  const { rows } = await client.query<{ column_name: string }>(
    "select column_name from information_schema.columns where table_name = 'eval_case_versions'",
  );
  const columns = rows.map(({ column_name }) => column_name);
  for (const gone of ["state", "approved_by", "approved_at"]) assert.ok(!columns.includes(gone));
});

test("a run keeps the versions that it froze", async () => {
  const { db } = await migrated();
  const [frozen] = await createDrizzleExperimentStore(db).caseVersions([versionId(BOTH, 1)]);
  assert.deepEqual([frozen?.number, frozen?.input], [1, "first"]);
});

async function migrated() {
  const client = new PGlite();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files.filter((name) => name < MIGRATION)) {
    await client.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  await client.exec(`
    create table organizations (id uuid primary key, name text not null, slug text not null unique);
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
    insert into eval_definitions (id, project_id, name, created_by) values ('${EVAL}', '${PROJECT_ID}', 'Refunds', 'u');
    insert into eval_cases (id, project_id, eval_id, name, created_by) values
      ('${BOTH}', '${PROJECT_ID}', '${EVAL}', 'both', 'u'),
      ('${DRAFT}', '${PROJECT_ID}', '${EVAL}', 'draft', 'u');
  `);
  const version = (caseId: string, number: number, state: string, input: string) =>
    client.query(
      `insert into eval_case_versions (id, case_id, number, state, input, earlier_turns, tool_fixtures)
       values ($1, $2, $3, $4, $5, '[]', '[]')`,
      [versionId(caseId, number), caseId, number, state, JSON.stringify({ value: input })],
    );
  await version(BOTH, 1, "approved", "first");
  await version(BOTH, 2, "draft", "edited");
  await version(DRAFT, 1, "draft", "draft only");
  await client.exec(readFileSync(join(MIGRATIONS_DIR, MIGRATION), "utf8"));
  // biome-ignore lint/suspicious/noExplicitAny: PGlite stands in for the Postgres client
  return { client, db: drizzle(client) as any };
}

function versionId(caseId: string, number: number): string {
  return `${caseId.slice(0, 35)}${number}`;
}
