import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_MIGRATIONS_DIR,
  type LockClient,
  MIGRATION_LOCK_KEY,
  migrateOnBootEnabled,
  withMigrationLock,
} from "./migrate";

function recordingClient() {
  const calls: Array<[string, unknown[] | undefined]> = [];
  const client: LockClient = {
    async query(text, values) {
      calls.push([text, values]);
    },
  };
  return { client, calls };
}

test("the migration runs between lock and unlock on the same connection", async () => {
  const { client, calls } = recordingClient();
  const result = await withMigrationLock(client, async () => {
    assert.equal(calls.length, 1, "locked before migrating");
    return "done";
  });
  assert.equal(result, "done");
  assert.deepEqual(calls, [
    ["select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]],
    ["select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]],
  ]);
});

test("a failing migration still releases the lock and rethrows", async () => {
  const { client, calls } = recordingClient();
  await assert.rejects(
    withMigrationLock(client, async () => {
      throw new Error("relation already exists");
    }),
    /already exists/,
  );
  assert.equal(calls.length, 2);
  assert.match(calls[1][0], /unlock/);
});

test("migrate on boot: on by default for OSS, off for Ratel, explicit flag wins, never without a database", () => {
  const url = { DATABASE_URL: "postgres://x" };
  assert.equal(migrateOnBootEnabled({ ...url }), true);
  assert.equal(migrateOnBootEnabled({ ...url, RATEL_COMPOSITION: "oss" }), true);
  assert.equal(migrateOnBootEnabled({ ...url, RATEL_COMPOSITION: "cloud" }), false);
  assert.equal(migrateOnBootEnabled({ ...url, DATABASE_MIGRATE_ON_BOOT: "0" }), false);
  assert.equal(
    migrateOnBootEnabled({ ...url, RATEL_COMPOSITION: "cloud", DATABASE_MIGRATE_ON_BOOT: "1" }),
    true,
  );
  assert.equal(migrateOnBootEnabled({ DATABASE_MIGRATE_ON_BOOT: "1" }), false);
  assert.equal(migrateOnBootEnabled({}), false);
});

// The migrator applies only entries newer than the last one it recorded, so a lower `when` is
// skipped silently, and the integration tests read the folder while production reads the journal.
test("the journal lists every migration file, in order, with strictly increasing times", () => {
  const { entries } = JSON.parse(
    readFileSync(join(DEFAULT_MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string; when: number }> };
  const files = readdirSync(DEFAULT_MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  assert.deepEqual(
    entries.map((entry) => `${entry.tag}.sql`),
    files,
  );
  for (let i = 1; i < entries.length; i++) {
    assert.ok(
      entries[i].when > entries[i - 1].when,
      `${entries[i].tag} is not newer than the one before`,
    );
  }
});
