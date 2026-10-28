import assert from "node:assert/strict";
import { test } from "node:test";
import {
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

test("migrate on boot: on by default for OSS, off for Cloud, explicit flag wins, never without a database", () => {
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
