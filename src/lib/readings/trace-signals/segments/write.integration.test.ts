import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
async function setupDb() {
  const client = await createMigratedPGlite();
  await client.exec(`insert into organizations (id,name,slug) values ('22222222-2222-4222-8222-222222222222','Test','test');
    insert into projects (id,organization_id,name,slug) values ('${PROJECT_ID}','22222222-2222-4222-8222-222222222222','Test','test')`);
  return { client, db: drizzle(client, { schema }) as unknown as ReturnType<typeof getDb> };
}

import { loadTurnTools } from "../workflows/decide-queries";
import { writeTaskPlacement } from "../workflows/place-queries";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const window = { start: new Date("2026-09-01"), end: new Date("2026-10-01") };

test("segment placement splits a trace, merges three traces, and survives a repeated write", async () => {
  const { client, db } = await setupDb();
  for (let n = 1; n <= 4; n++) {
    await client.query(
      `insert into trace_turns (id,project_id,session_id,turn_key,turn_source,lane,status,started_at,ended_at,last_received_at)
      values ($1::uuid,$2,$3,$1::text,'otlp','otlp','closed',$4,$4::timestamptz + interval '1 second',$4)`,
      [
        id(n),
        PROJECT_ID,
        n === 1 ? "docs" : "cross",
        `2026-09-${String(9 + n).padStart(2, "0")}T00:00:00Z`,
      ],
    );
    const tokens = n === 1 ? ["one", "two", "three"] : ["one"];
    if (n === 1)
      await client.query(
        `insert into trace_turn_steps (turn_id,project_id,ordinal,kind,event_type,trace_event_id,occurred_at,received_at,target_id,outcome)
      values ($1,$2,1,'code','otlp_step',$3,'2026-09-10','2026-09-10','setup','ok')`,
        [id(n), PROJECT_ID, id(99)],
      );
    for (const [i, token] of tokens.entries()) {
      await client.query(
        `insert into trace_turn_steps (turn_id,project_id,ordinal,kind,event_type,trace_event_id,occurred_at,received_at,target_id,outcome,took_ms)
        values ($1,$2,$3,'user_message','otlp_step',$4,$5,$5,null,'ok',0),($1,$2,$3+1,'model_call','otlp_model_call',$4,$5,$5,$6,'ok',100)`,
        [
          id(n),
          PROJECT_ID,
          i * 2 + (n === 1 ? 2 : 1),
          id(100 + n * 10 + i),
          `2026-09-${String(9 + n).padStart(2, "0")}T00:00:00Z`,
          token,
        ],
      );
    }
  }
  assert.deepEqual((await loadTurnTools([id(1)], db)).get(id(1)), [
    "code:setup",
    "model:one",
    "model:two",
    "model:three",
  ]);
  const tasks = ["one", "two", "three"].map((token) => ({
    id: token,
    coreTools: [`model:${token}`],
  }));
  const input = { window, segments: { tasks, weights: {}, basis: "all" as const } };
  await writeTaskPlacement(PROJECT_ID, input, db);
  const read = async () =>
    (
      await client.query<{
        id: string;
        session_id: string;
        workflow_id: string;
        start_turn_id: string;
        end_turn_id: string;
        start_ordinal: number;
        end_ordinal: number;
        piece_count: number;
      }>(
        `select id,session_id,workflow_id,start_turn_id,end_turn_id,start_ordinal,end_ordinal,piece_count from task_segments order by session_id,start_ordinal`,
      )
    ).rows;
  const first = await read();
  assert.equal(first.length, 4);
  assert.deepEqual(
    first.filter((r) => r.session_id === "docs").map((r) => r.workflow_id),
    ["one", "two", "three"],
  );
  assert.equal(first[0]!.piece_count, 3);
  assert.equal(first[0]!.start_turn_id, id(2));
  assert.equal(first[0]!.end_turn_id, id(4));
  assert.deepEqual(
    (
      await client.query<{ workflow_id: string }>(`select workflow_id from trace_turns order by id`)
    ).rows.map((r) => r.workflow_id),
    ["one", "one", "one", "one"],
  );
  await writeTaskPlacement(PROJECT_ID, input, db);
  assert.deepEqual(await read(), first);
  await client.query(`delete from trace_turns where id=$1`, [id(3)]);
  assert.equal(
    (
      await client.query<{ n: number }>(
        `select count(*)::int as n from task_segments where session_id='cross'`,
      )
    ).rows[0]!.n,
    0,
  );
  await client.close();
});
