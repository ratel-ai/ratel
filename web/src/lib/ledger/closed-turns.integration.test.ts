import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  countClosedTurns,
  hasLedger,
  hasModelCallsSince,
  ledgerStartedAt,
  listClosedTurnsPage,
  type SignalsDb,
} from "./closed-turns";

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const T0 = new Date("2026-10-01T10:00:00Z");

async function setup(): Promise<SignalsDb> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'A', 'a');
  `);
  return drizzle(client) as unknown as SignalsDb;
}

/** `n` closed turns a minute apart from T0, plus one open turn after them. */
async function seedTurns(db: SignalsDb, n: number): Promise<void> {
  const rows: string[] = [];
  for (let i = 0; i < n; i++) {
    const at = new Date(T0.getTime() + i * 60_000).toISOString();
    rows.push(
      `('${PROJECT_ID}', 'sess-${i}', 'inferred:e${i}', 'inferred', 'runtime', 'closed', 'gap', '${at}', '${at}', '${at}', 1, 1)`,
    );
  }
  const open = new Date(T0.getTime() + n * 60_000).toISOString();
  rows.push(
    `('${PROJECT_ID}', 'sess-open', 'inferred:open', 'inferred', 'runtime', 'open', null, '${open}', '${open}', '${open}', 1, 0)`,
  );
  await db.execute(
    `insert into trace_turns (project_id, session_id, turn_key, turn_source, lane, status, ended_by, started_at, ended_at, last_received_at, search_count, invoke_count) values ${rows.join(",")}`,
  );
  await db.execute(`
    insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at)
    select id, project_id, 1, 'search', 'search', gen_random_uuid(), started_at, started_at from trace_turns
  `);
}

test("closed turns page by (ended_at, id) with their steps, open turns excluded", async () => {
  const db = await setup();
  await seedTurns(db, 5);
  const range = { from: new Date(0), to: new Date(T0.getTime() + 60 * 60_000) };

  const first = await listClosedTurnsPage(PROJECT_ID, { ...range, after: null }, db, 2);
  assert.equal(first.turns.length, 2);
  assert.deepEqual(
    first.turns.map((t) => t.sessionId),
    ["sess-0", "sess-1"],
  );
  assert.equal(first.turns[0]?.steps.length, 1);
  assert.equal(first.turns[0]?.endedBy, "gap");
  assert.ok(first.next);

  const second = await listClosedTurnsPage(PROJECT_ID, { ...range, after: first.next }, db, 2);
  assert.deepEqual(
    second.turns.map((t) => t.sessionId),
    ["sess-2", "sess-3"],
  );
  const third = await listClosedTurnsPage(PROJECT_ID, { ...range, after: second.next }, db, 2);
  assert.deepEqual(
    third.turns.map((t) => t.sessionId),
    ["sess-4"],
  );
  const done = await listClosedTurnsPage(PROJECT_ID, { ...range, after: third.next }, db, 2);
  assert.deepEqual(done, { turns: [], next: null });

  assert.equal(await countClosedTurns(PROJECT_ID, range.from, range.to, db), 5);
  assert.equal(
    await countClosedTurns(PROJECT_ID, new Date(T0.getTime() + 3 * 60_000), range.to, db),
    2,
  );
});

test("ledger presence and reach answer from any turn and the earliest closed one", async () => {
  const db = await setup();
  assert.equal(await hasLedger(PROJECT_ID, db), false);
  assert.equal(await ledgerStartedAt(PROJECT_ID, db), null);
  assert.equal(await hasModelCallsSince(PROJECT_ID, new Date(0), db), false);

  await seedTurns(db, 3);

  assert.equal(await hasLedger(PROJECT_ID, db), true);
  assert.equal((await ledgerStartedAt(PROJECT_ID, db))?.getTime(), T0.getTime());
});
