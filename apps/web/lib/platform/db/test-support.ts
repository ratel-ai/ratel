import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";

// Integration tests run against an in-process PGlite. Replaying every migration on a fresh
// database once per test dominates wall-clock, so migrate once per process, snapshot the result,
// and hand each test a freshly loaded, fully isolated copy.
//
// A `loadDataDir` PGlite keeps a handle open that a no-arg one does not, so the runner will not
// exit on its own once a file has used this. The `test` script runs with `--test-force-exit`,
// which fires only after all tests finish and so cannot mask a hanging test.
let snapshot: Promise<File | Blob> | undefined;

/** The open-source migrations, next to this file, so the test runner's cwd does not matter. */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Not a core table: the edition's identity module owns `organizations`. Fixtures copied from
 * upstream still insert a row before their projects, so tests get a minimal one.
 */
const ORGANIZATIONS_FIXTURE_SQL = `create table organizations (
  id uuid primary key, name text not null, slug text not null unique
)`;

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
});

function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
}

function migratedSnapshot(): Promise<File | Blob> {
  snapshot ??= (async () => {
    const client = new PGlite();
    for (const sql of migrationStatements()) {
      await client.exec(sql);
    }
    await client.exec(ORGANIZATIONS_FIXTURE_SQL);
    const dump = await client.dumpDataDir("none");
    await client.close();
    return dump;
  })();
  return snapshot;
}

/** A migrated, otherwise-empty PGlite. Each call returns a fully isolated database. */
export async function createMigratedPGlite(): Promise<PGlite> {
  return new PGlite({ loadDataDir: await migratedSnapshot() });
}
