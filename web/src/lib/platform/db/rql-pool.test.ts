import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool, PoolConfig } from "pg";
import { resolveConfig } from "@/config";
import { createRqlPool, RQL_POOL_MAX, rqlDatabaseUrl } from "@/lib/platform/db/rql-pool";

test("RQL_DATABASE_URL wins over DATABASE_URL", () => {
  const config = resolveConfig({
    env: { DATABASE_URL: "postgres://primary/ratel", RQL_DATABASE_URL: "postgres://replica/ratel" },
  });
  assert.equal(rqlDatabaseUrl(config), "postgres://replica/ratel");
});

test("without RQL_DATABASE_URL, RQL uses DATABASE_URL", () => {
  const config = resolveConfig({ env: { DATABASE_URL: "postgres://primary/ratel" } });
  assert.equal(rqlDatabaseUrl(config), "postgres://primary/ratel");
});

test("createRqlPool opens a small pool of its own on the RQL url", () => {
  const made: PoolConfig[] = [];
  const config = resolveConfig({
    env: { DATABASE_URL: "postgres://primary/ratel", RQL_DATABASE_URL: "postgres://replica/ratel" },
  });
  createRqlPool(config, (poolConfig) => {
    made.push(poolConfig);
    return fakePool();
  });
  assert.equal(made.length, 1);
  assert.equal(made[0].connectionString, "postgres://replica/ratel");
  assert.equal(made[0].max, RQL_POOL_MAX);
  assert.ok(RQL_POOL_MAX < config.database.poolMax, "smaller than the primary pool");
});

test("createRqlPool fails with a clear message when no database is configured", () => {
  assert.throws(() => createRqlPool(resolveConfig(), fakePool), /RQL_DATABASE_URL or DATABASE_URL/);
});

function fakePool(): Pick<Pool, "on"> {
  return { on: () => ({}) } as unknown as Pick<Pool, "on">;
}
