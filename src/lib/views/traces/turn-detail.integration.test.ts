import assert from "node:assert/strict";
import { test } from "node:test";
import { asc } from "drizzle-orm";
import { traceTurns } from "@/lib/ledger/schema";
import {
  type Db,
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { fresh } from "@/lib/readings/trace-signals/signals/test-fixtures";
import { loadTurnDetail } from "@/lib/views/traces/turn-detail";

/*
 * The page an Agent health example opens in Traces: every kind of turn the
 * ledger keeps resolves to its calls, in order, with the live query and error
 * text, and a trace link only where Traces holds the trace.
 */

async function turnIds(db: Db): Promise<{ id: string; sessionId: string; startedAt: Date }[]> {
  return db
    .select({ id: traceTurns.id, sessionId: traceTurns.sessionId, startedAt: traceTurns.startedAt })
    .from(traceTurns)
    .orderBy(asc(traceTurns.startedAt));
}

test("an inferred runtime turn opens with every call, the query, the hits and the error text", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, [
    fresh({ session: "s-1" })
      .search(["find_task", "update_task"], { query: "move RC-40 to review" })
      .invoke("update_task")
      .error("update_task"),
  ]);
  const [turn] = await turnIds(db);
  assert.ok(turn);
  await client.query(
    `update trace_events set error_message = 'RC-40 is locked' where project_id = $1 and type = 'invoke_error'`,
    [PROJECT_ID],
  );

  const detail = await loadTurnDetail(PROJECT_ID, turn.id, db);
  assert.ok(detail);
  assert.equal(detail.sessionId, "s-1");
  assert.equal(detail.turnSource, "inferred");
  assert.deepEqual(
    detail.calls.map((call) => [call.ordinal, call.kind, call.targetId]),
    [
      [1, "search", null],
      [2, "invoke", "update_task"],
    ],
  );
  const [search, call] = detail.calls;
  assert.deepEqual(search?.query, { state: "captured", text: "move RC-40 to review" });
  assert.equal(search?.hitCount, 2);
  assert.deepEqual(
    search?.hits.map((hit) => [hit.rank, hit.id]),
    [
      [1, "find_task"],
      [2, "update_task"],
    ],
  );
  assert.equal(call?.outcome, "error");
  assert.equal(call?.offeredRank, 2);
  assert.equal(
    call?.errorMessage,
    "RC-40 is locked",
    "the error text comes from the call's end event",
  );
  assert.equal(call?.traceId, null, "no trace in Traces, no trace link");
  assert.equal(detail.previousTurnId, null);
  assert.equal(detail.nextTurnId, null);
});

test("skill, gateway and declared turns resolve too, with neighbours in their session", async () => {
  const { client, db } = await setupDb();
  const first = fresh({ session: "s-2", turnId: "turn-a" }).skillSearch(["writer"]).skill("writer");
  const second = fresh({ after: first, turnId: "turn-b", gapMs: 60_000 })
    .gatewaySearch(4)
    .gatewayInvoke("create_doc");
  await seedLedger(client, db, [first, second]);
  const [a, b] = await turnIds(db);
  assert.ok(a && b);

  const skill = await loadTurnDetail(PROJECT_ID, a.id, db);
  assert.equal(skill?.turnSource, "declared");
  assert.deepEqual(
    skill?.calls.map((c) => [c.kind, c.targetType, c.targetId]),
    [
      ["search", null, null],
      ["invoke", "skill", "writer"],
    ],
  );
  assert.equal(skill?.nextTurnId, b.id);
  assert.equal(skill?.previousTurnId, null);

  const gateway = await loadTurnDetail(PROJECT_ID, b.id, db);
  assert.equal(gateway?.calls[0]?.hitCount, 4, "a gateway search has a count and no ids");
  assert.deepEqual(gateway?.calls[0]?.hits, []);
  assert.equal(gateway?.calls[1]?.targetId, "create_doc");
  assert.equal(gateway?.previousTurnId, a.id);
});

test("a trace is linked only when Traces holds it, and pruned events read expired", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, [
    fresh({ traceId: "trace-held" }).search(["a"], { query: "q" }).invoke("a"),
  ]);
  const [turn] = await turnIds(db);
  assert.ok(turn);
  assert.equal(
    (await loadTurnDetail(PROJECT_ID, turn.id, db))?.calls[0]?.traceId,
    null,
    "the id alone is not enough",
  );

  await client.query(
    `insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error, input_tokens,
       output_tokens, cost_usd, spans_max_received_at)
     values ($1, 'trace-held', now(), 10, false, 0, 0, 0, now())`,
    [PROJECT_ID],
  );
  const held = await loadTurnDetail(PROJECT_ID, turn.id, db);
  assert.ok(held?.calls.every((call) => call.traceId === "trace-held"));

  await client.query(`delete from trace_events where project_id = $1`, [PROJECT_ID]);
  const pruned = await loadTurnDetail(PROJECT_ID, turn.id, db);
  assert.deepEqual(pruned?.calls[0]?.query, { state: "expired" });
  assert.equal(pruned?.calls.length, 2, "the ledger outlives the events");
  assert.equal(pruned?.calls[0]?.traceId, null);
});

test("an id that is not a turn of this project reads as none", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, [fresh().search(["a"]).invoke("a")]);
  const [turn] = await turnIds(db);
  assert.ok(turn);
  assert.equal(await loadTurnDetail("99999999-9999-4999-8999-999999999999", turn.id, db), null);
  assert.equal(await loadTurnDetail(PROJECT_ID, "not-a-uuid", db), null);
  assert.equal(await loadTurnDetail(PROJECT_ID, "88888888-8888-4888-8888-888888888888", db), null);
});
