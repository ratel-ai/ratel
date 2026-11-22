import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { loadModelCallFacts, loadStepFinishInputs } from "./metrics-query";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const window = { start: new Date("2026-09-01T00:00:00Z"), end: new Date("2026-10-01T00:00:00Z") };

async function setupDb() {
  const client = await createMigratedPGlite();
  await client.exec(`insert into organizations (id,name,slug) values ('22222222-2222-4222-8222-222222222222','Test','test');
    insert into projects (id,organization_id,name,slug) values ('${PROJECT_ID}','22222222-2222-4222-8222-222222222222','Test','test')`);
  return { client, db: drizzle(client, { schema }) as unknown as ReturnType<typeof getDb> };
}

test("model-call facts join the priced call by trace and span, in the window only", async () => {
  const { client, db } = await setupDb();
  const insertCall = (n: number, at: string, span: string, payload: object) =>
    client.query(
      `insert into trace_events (id,project_id,client_event_id,type,ingest_source,session_id,trace_id,span_id,occurred_at,input_tokens,output_tokens,payload)
     values ($1,$2,$6,'otlp_model_call','otlp','s','trace-1',$3,$4,120,30,$5::jsonb)`,
      [id(n), PROJECT_ID, span, at, JSON.stringify(payload), `otlp:model:${span}`],
    );
  await insertCall(1, "2026-09-10T00:00:00Z", "span-1", { reasoning_tokens: 12 });
  await insertCall(2, "2026-09-10T00:00:01Z", "span-2", {});
  await insertCall(3, "2026-08-01T00:00:00Z", "span-3", {});
  await client.query(
    `insert into events (project_id,trace_id,span_id,finish_reason,cost_usd,payload,dedupe_hash) values ($1,'trace-1','span-1','length',0.0125,'{}'::jsonb,'h1')`,
    [PROJECT_ID],
  );

  const facts = await loadModelCallFacts(PROJECT_ID, window, db);

  assert.deepEqual(facts.get(id(1)), {
    inputTokens: 120,
    outputTokens: 30,
    reasoningTokens: 12,
    costUsd: 0.0125,
    finishReason: "length",
  });
  assert.deepEqual(facts.get(id(2)), {
    inputTokens: 120,
    outputTokens: 30,
    reasoningTokens: null,
    costUsd: null,
    finishReason: null,
  });
  assert.equal(facts.has(id(3)), false);
  await client.close();
});

test("finish inputs read the window's segments and the topics of its runs", async () => {
  const { client, db } = await setupDb();
  for (const [n, ended] of [
    [1, "2026-09-10T00:00:00Z"],
    [2, "2026-08-10T00:00:00Z"],
  ] as const) {
    await client.query(
      `insert into trace_turns (id,project_id,session_id,turn_key,turn_source,lane,status,started_at,ended_at,last_received_at)
      values ($1,$2,'s',$4,'otlp','otlp','closed',$3,$3,$3)`,
      [id(n), PROJECT_ID, ended, `turn-${n}`],
    );
    await client.query(
      `insert into task_segments (id,project_id,session_id,workflow_id,start_turn_id,start_ordinal,end_turn_id,end_ordinal,started_at,ended_at,turn_ids,piece_count)
      values ($1,$2,'s','task',$3,1,$3,4,$4,$4,array[$3]::uuid[],1)`,
      [id(10 + n), PROJECT_ID, id(n), ended],
    );
    await client.query(
      `insert into trace_turn_topics (turn_id,project_id,verdict,sentiment,started_at) values ($1,$2,$3,$4,$5)`,
      [id(n), PROJECT_ID, n === 1 ? "retry" : "topic", n === 1 ? "negative" : null, ended],
    );
  }

  const inputs = await loadStepFinishInputs(PROJECT_ID, window, db);

  assert.deepEqual(inputs.segments, [
    {
      workflowId: "task",
      startTurnId: id(1),
      startOrdinal: 1,
      endTurnId: id(1),
      endOrdinal: 4,
      startedAt: new Date("2026-09-10T00:00:00Z"),
      endedAt: new Date("2026-09-10T00:00:00Z"),
      turnIds: [id(1)],
    },
  ]);
  assert.deepEqual(
    [...inputs.topics!.entries()],
    [[id(1), { sentiment: "negative", askedAgain: true }]],
  );
  await client.close();
});
