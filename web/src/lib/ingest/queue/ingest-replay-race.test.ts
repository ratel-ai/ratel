import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import {
  describeError,
  emptyRange,
  type RebuildDb,
  type ReplayRange,
  rebuildRange,
  sqlStateOf,
} from "@/ingest-replay";
import { runMigrations } from "@/lib/platform/db/migrate";

/**
 * A REBUILD while the organization sends: App's worker stores a new call of the same tool, and moves its
 * counter, between the removal's snapshot and its update. Two connections, which PGlite does not have:
 * with TEST_POSTGRES_URL (a server where a database may be created) this runs on a database of its own.
 */
const server = process.env.TEST_POSTGRES_URL;
const DATABASE = `ratel_replay_race_${process.pid}`;
const PROJECT = "11111111-1111-4111-8111-111111111111";
const needsServer = { skip: server ? false : "TEST_POSTGRES_URL is not set" };

let pool: Pool;

before(async () => {
  if (!server) return;
  await asAdmin(`create database ${DATABASE}`);
  const url = new URL(server);
  url.pathname = `/${DATABASE}`;
  await runMigrations({ url: url.href, sslMode: "disable" });
  pool = new Pool({ connectionString: url.href, max: 4 });
  await pool.query(
    `insert into projects (id, organization_id, name, slug) values ($1, $1, 'Agent', 'agent')`,
    [PROJECT],
  );
});

after(async () => {
  if (!server) return;
  await pool.end();
  await asAdmin(`drop database ${DATABASE}`);
});

async function asAdmin(statement: string): Promise<void> {
  const client = new Client({ connectionString: server });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

/** One finished call of `tool`, stored as the worker stores it: the event, and its counter moved. */
async function storeCall(db: Pick<Pool, "query">, took: number): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into trace_events (id, project_id, type, schema_version, session_id, occurred_at, ingest_source,
       client_event_id, payload, source_id, tool_id, took_ms)
     values ($1, $2, 'invoke_end', 2, 's1', now(), 'runtime', $4, '{}', 'src', 'tool', $3)`,
    [id, PROJECT, took, id],
  );
  await db.query(
    `insert into tool_usage_counters (project_id, source_id, tool_id, calls, errors, total_duration_ms, first_used_at, last_used_at)
     values ($1, 'src', 'tool', 1, 0, $2, now(), now())
     on conflict (project_id, source_id, tool_id) do update set calls = tool_usage_counters.calls + 1,
       total_duration_ms = tool_usage_counters.total_duration_ms + excluded.total_duration_ms`,
    [PROJECT, took],
  );
  return id;
}

async function reset(): Promise<void> {
  await pool.query("delete from trace_events; delete from tool_usage_counters");
}

/**
 * The database the REBUILD runs on. In its first transaction, right after the first statement (which
 * takes the snapshot), the worker stores a call of the same tool on a connection of its own, and commits.
 */
function racedDb(): { db: RebuildDb; transactions: () => number } {
  const db = drizzle(pool);
  let transactions = 0;
  const raced: RebuildDb = {
    transaction: ((run: (tx: unknown) => Promise<unknown>, config?: unknown) =>
      db.transaction(async (tx) => {
        transactions += 1;
        let statements = 0;
        const first = transactions === 1;
        const wrapped = {
          execute: async (query: Parameters<typeof tx.execute>[0]) => {
            const result = await tx.execute(query);
            statements += 1;
            if (first && statements === 1) await storeCall(pool, 5);
            return result;
          },
        };
        return run(wrapped);
      }, config as never)) as RebuildDb["transaction"],
  };
  return { db: raced, transactions: () => transactions };
}

function rangeOf(eventIds: string[]): ReplayRange {
  const range = emptyRange();
  range.eventIds.set(PROJECT, new Set(eventIds));
  return range;
}

async function storedCalls() {
  const { rows: events } = await pool.query<{ took_ms: number }>(
    "select took_ms from trace_events order by took_ms",
  );
  const { rows: counters } = await pool.query<{ calls: string; total_duration_ms: string }>(
    "select calls, total_duration_ms from tool_usage_counters",
  );
  return { events, counters };
}

test(
  "REBUILD removes its range while the worker stores another call of the same tool",
  needsServer,
  async () => {
    await reset();
    const replayed = await storeCall(pool, 7);
    const { db, transactions } = racedDb();
    const retries: string[] = [];
    const result = await rebuildRange(db, rangeOf([replayed]), {
      sleep: async () => undefined,
      onRetry: (_attempt, error) => retries.push(sqlStateOf(error) ?? "none"),
    });
    assert.deepEqual(retries, ["40001"], "the first try met the worker's write");
    assert.equal(result.attempts, 2);
    assert.equal(transactions(), 2);
    // The replayed call is gone and its counts taken back; the worker's call and its count stay.
    assert.deepEqual(await storedCalls(), {
      events: [{ took_ms: 5 }],
      counters: [{ calls: "1", total_duration_ms: "5" }],
    });
  },
);

test(
  "a REBUILD that runs out of tries names the failed query and its cause",
  needsServer,
  async () => {
    await reset();
    const replayed = await storeCall(pool, 7);
    const { db } = racedDb();
    const error = await rebuildRange(db, rangeOf([replayed]), { attempts: 1 }).then(
      () => assert.fail("the removal met the worker's write"),
      (e: unknown) => e,
    );
    assert.equal(sqlStateOf(error), "40001");
    const line = describeError(error);
    assert.match(line, /^failed query: with gone as \( delete from trace_events/);
    assert.match(line, /could not serialize access due to concurrent update \(SQLSTATE 40001\)$/);
    assert.doesNotMatch(line, /params:/);
    // Rolled back: nothing was removed, nothing counted twice.
    assert.deepEqual(await storedCalls(), {
      events: [{ took_ms: 5 }, { took_ms: 7 }],
      counters: [{ calls: "2", total_duration_ms: "12" }],
    });
  },
);

test("describeError of an error without a query keeps its message and adds each cause", () => {
  const cause = Object.assign(new Error("deadlock detected"), { code: "40P01" });
  assert.equal(
    describeError(new Error("removal failed", { cause })),
    "removal failed: deadlock detected (SQLSTATE 40P01)",
  );
  assert.equal(sqlStateOf(new Error("x", { cause })), "40P01");
  assert.equal(sqlStateOf(new Error("x")), undefined);
});

test("REBUILD does not retry an error that is not a serialization failure", async () => {
  let tries = 0;
  const db = {
    transaction: async () => {
      tries += 1;
      throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
    },
  } as unknown as RebuildDb;
  await assert.rejects(
    rebuildRange(db, emptyRange(), { sleep: async () => undefined }),
    /relation/,
  );
  assert.equal(tries, 1);
});
