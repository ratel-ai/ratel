import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool, PoolConfig } from "pg";
import { resolveConfig } from "@/config";
import { createRqlPool } from "@/lib/platform/db/rql-pool";
import { createPgRqlExecutor, RQL_ROLE, type RqlPool } from "../adapters/pg-executor";
import { compileRql } from "../compile";
import { createRqlGate, runRql } from "../run";

const PRIMARY = "postgres://app@primary/ratel";
const REPLICA = "postgres://rql@replica/ratel";

/** A pool that answers every query with no row and keeps the text of each query. */
class FakePool implements RqlPool {
  readonly queries: string[] = [];
  constructor(readonly url: string | undefined) {}
  on() {
    return this;
  }
  async connect() {
    return {
      query: async ({ text }: { text: string }) => {
        this.queries.push(text);
        return { rows: [] };
      },
      release: () => {},
    };
  }
}

async function runOn(env: Record<string, string>) {
  const config = resolveConfig({ env });
  const primary = new FakePool(config.database.url);
  const made: FakePool[] = [];
  const rqlPool = createRqlPool(config, (poolConfig: PoolConfig) => {
    const pool = new FakePool(poolConfig.connectionString);
    made.push(pool);
    return pool as FakePool & Pick<Pool, "on">;
  });
  const compiled = compileRql("select count(*) from traces", { now: new Date() });
  assert.ok(compiled.ok);
  const result = await runRql(
    compiled,
    { projectId: "11111111-1111-4111-8111-111111111111" },
    { executor: createPgRqlExecutor(rqlPool), gate: createRqlGate(), observe: async () => {} },
  );
  assert.ok(result.ok);
  return { primary, made, compiled };
}

test("with RQL_DATABASE_URL set, every RQL query goes to its pool and none to the primary", async () => {
  const { primary, made, compiled } = await runOn({
    DATABASE_URL: PRIMARY,
    RQL_DATABASE_URL: REPLICA,
  });
  assert.equal(made.length, 1);
  assert.equal(made[0].url, REPLICA);
  assert.ok(made[0].queries.includes(`set local role ${RQL_ROLE}`));
  assert.ok(made[0].queries.includes(compiled.sql));
  assert.deepEqual(primary.queries, []);
});

test("without RQL_DATABASE_URL, RQL still has a pool of its own on DATABASE_URL", async () => {
  const { primary, made } = await runOn({ DATABASE_URL: PRIMARY });
  assert.equal(made.length, 1);
  assert.equal(made[0].url, PRIMARY);
  assert.notEqual(made[0], primary);
  assert.deepEqual(primary.queries, []);
});
