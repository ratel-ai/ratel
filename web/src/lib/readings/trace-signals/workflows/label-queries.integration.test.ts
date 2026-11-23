import assert from "node:assert/strict";
import { test } from "node:test";
import { TurnFixture } from "@/lib/ledger/test-support";
import {
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import {
  loadRecentAskGroups,
  loadVerdicts,
  loadWorkflowInsights,
  saveInsights,
  saveVerdicts,
} from "@/lib/readings/trace-signals/workflows/decide-queries";
import {
  enqueueLabelWorkflowsJob,
  loadAskSourcesByTurn,
  loadAsksByTurn,
  loadLabelHashes,
  loadWorkflowLabels,
  saveLabel,
} from "@/lib/readings/trace-signals/workflows/label-queries";

/**
 * The label and decision steps against a real schema (migration 0056): asks
 * come from an SDK turn's first search and from an OTel run's model call,
 * labels upsert by workflow, verdicts cache by (ask, option set), and the
 * label job is queued once per project.
 */

const TRACE = "f".repeat(32);

async function seed() {
  const { client, db } = await setupDb();
  const sdk = new TurnFixture({ session: "s-sdk" })
    .search(["find_pr"], { query: "close out release 4.2" })
    .invoke("find_pr");
  const otel = new TurnFixture({ session: "s-otel", lane: "otlp", traceId: TRACE }).invoke(
    "get_board_summary",
  );
  await seedLedger(client, db, [sdk, otel]);
  const startedAt = new Date(otel.rows()[0].occurredAt!.getTime() - 500).toISOString();
  await client.query(
    `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, client_event_id, trace_id, ingest_source, payload)
     values ('99999999-9999-4999-8999-999999999999', $1, 'otlp_model_call', 's-otel', $2, $2, 'model-1', $3, 'otlp', $4::jsonb)`,
    [
      PROJECT_ID,
      startedAt,
      TRACE,
      JSON.stringify({ type: "otlp_model_call", prompt: "export the board as PDF" }),
    ],
  );
  const turns = (
    await client.query<{ id: string; turn_key: string }>(
      `select id, turn_key from trace_turns order by turn_key`,
    )
  ).rows;
  return { client, db, turns };
}

test("asks come from the first search of an SDK turn and the model call of an OTel run", async () => {
  const { db, turns } = await seed();
  const byKey = new Map(turns.map((t) => [t.turn_key, t.id]));
  const asks = await loadAsksByTurn(
    PROJECT_ID,
    turns.map((t) => t.id),
    db,
  );
  assert.equal(asks.get(byKey.get(`otlp:${TRACE}`)!), "export the board as PDF");
  const sdkTurn = turns.find((t) => !t.turn_key.startsWith("otlp:"))!;
  assert.equal(asks.get(sdkTurn.id), "close out release 4.2");

  const groups = await loadRecentAskGroups(PROJECT_ID, new Date("2026-01-01T00:00:00Z"), 10, db);
  assert.deepEqual(groups.map((g) => g.ask).sort(), [
    "close out release 4.2",
    "export the board as PDF",
  ]);
  const otelGroup = groups.find((g) => g.ask === "export the board as PDF")!;
  assert.deepEqual(
    otelGroup.turns.map((t) => [t.tools, t.invokes, t.errors]),
    [[["get_board_summary"], 1, 0]],
  );
});

test("a turn scope's user message wins over the search that stood in for it", async () => {
  const { client, db } = await setupDb();
  const declared = new TurnFixture({ session: "s-turns", turnId: "turn-1" })
    .search(["find_pr"], { query: "find pr 4.2" })
    .invoke("find_pr");
  const silent = new TurnFixture({ session: "s-turns", turnId: "turn-2" })
    .search(["get_task"], { query: "get task" })
    .invoke("get_task");
  await seedLedger(client, db, [declared, silent]);
  const at = declared.rows()[0].occurredAt!.toISOString();
  await client.query(
    `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, client_event_id, ingest_source, payload)
     values ('88888888-8888-4888-8888-888888888888', $1, 'turn_start', 's-turns', $2, $2, 'start-1', 'runtime', $3::jsonb),
            ('77777777-7777-4777-8777-777777777777', $1, 'turn_start', 's-turns', $2, $2, 'start-2', 'runtime', $4::jsonb)`,
    [
      PROJECT_ID,
      at,
      JSON.stringify({
        type: "turn_start",
        turn_id: "turn-1",
        user_message: "close out release 4.2 and tell the team",
      }),
      JSON.stringify({ type: "turn_start", turn_id: "turn-2" }),
    ],
  );
  const turns = (
    await client.query<{ id: string; turn_key: string }>(
      `select id, turn_key from trace_turns order by turn_key`,
    )
  ).rows;
  const byKey = new Map(turns.map((t) => [t.turn_key, t.id]));
  const asks = await loadAskSourcesByTurn(
    PROJECT_ID,
    turns.map((t) => t.id),
    db,
  );
  assert.deepEqual(asks.get(byKey.get("declared:turn-1")!), {
    text: "close out release 4.2 and tell the team",
    source: "user_message",
  });
  assert.deepEqual(
    asks.get(byKey.get("declared:turn-2")!),
    { text: "get task", source: "search" },
    "no message: the search stands in",
  );
  const groups = await loadRecentAskGroups(PROJECT_ID, new Date("2026-01-01T00:00:00Z"), 10, db);
  assert.deepEqual(groups.map((g) => [g.ask, g.source]).sort(), [
    ["close out release 4.2 and tell the team", "user"],
    ["get task", "search"],
  ]);
});

test("labels upsert by workflow; verdicts cache by ask and option set; insights round trip", async () => {
  const { db } = await seed();
  await saveLabel(
    PROJECT_ID,
    {
      workflowId: "wf-1",
      inputHash: "h1",
      name: "Close out a release",
      description: "d",
      icon: "rocket",
      model: "m",
    },
    db,
  );
  await saveLabel(
    PROJECT_ID,
    {
      workflowId: "wf-1",
      inputHash: "h2",
      name: "Ship a release",
      description: "d2",
      icon: "git-pull-request",
      model: "m",
    },
    db,
  );
  assert.deepEqual([...(await loadLabelHashes(PROJECT_ID, db))], [["wf-1", "h2"]]);
  assert.equal((await loadWorkflowLabels(PROJECT_ID, db)).get("wf-1")?.name, "Ship a release");
  assert.equal((await loadWorkflowLabels(PROJECT_ID, db)).get("wf-1")?.icon, "git-pull-request");

  await saveVerdicts(
    PROJECT_ID,
    "opts-a",
    "test-model",
    [
      { promptHash: "p1", verdict: "workflow", workflowId: "wf-1", confidence: 0.93 },
      { promptHash: "p2", verdict: "none", workflowId: null, confidence: 0.9 },
    ],
    db,
  );
  const cached = await loadVerdicts(PROJECT_ID, "opts-a", ["p1", "p2", "p3"], db);
  assert.deepEqual([...cached].sort(), [
    ["p1", { entryId: "wf-1" }],
    ["p2", { entryId: "none" }],
  ]);
  assert.equal(
    (await loadVerdicts(PROJECT_ID, "opts-b", ["p1"], db)).size,
    0,
    "a new option set asks again",
  );

  assert.equal(await loadWorkflowInsights(PROJECT_ID, db), null);
  const data = {
    version: 3 as const,
    asksSeen: 2,
    judged: 2,
    unclear: 0,
    placed: { "wf-1": { turns: 1, outside: 0, outsideWithErrors: 0 } },
    unserved: [],
  };
  await saveInsights(PROJECT_ID, data, "test-model", db);
  await saveInsights(PROJECT_ID, { ...data, asksSeen: 3 }, "test-model", db);
  assert.equal((await loadWorkflowInsights(PROJECT_ID, db))?.data.asksSeen, 3);
});

test("the label job is queued once while one waits", async () => {
  const { client, db } = await setupDb();
  assert.ok(await enqueueLabelWorkflowsJob(PROJECT_ID, db));
  assert.equal(await enqueueLabelWorkflowsJob(PROJECT_ID, db), null);
  const { rows } = await client.query<{ n: number }>(
    `select count(*)::int as n from jobs where kind = 'label_workflows'`,
  );
  assert.equal(rows[0].n, 1);
});
