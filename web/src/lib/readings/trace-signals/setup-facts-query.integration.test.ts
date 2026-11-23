import assert from "node:assert/strict";
import { test } from "node:test";
import { TurnFixture } from "@/lib/ledger/test-support";
import { buildSetupFacts } from "@/lib/readings/trace-signals/setup-facts";
import { loadSetupCounts } from "@/lib/readings/trace-signals/setup-facts-query";
import {
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";

/** The setup counts against a real schema: SDK searches and turns, OTel tool rows and model calls. */

const WINDOW = { start: new Date("2026-08-01T00:00:00Z"), end: new Date("2026-10-01T00:00:00Z") };

test("setup counts read SDK and OpenTelemetry rows in the window", async () => {
  const { client, db } = await setupDb();
  const sdk = new TurnFixture({ session: "s-sdk", turnId: "t-1" })
    .search(["find_task"], { query: "find the task" })
    .invoke("find_task");
  const otel = new TurnFixture({ session: "s-otel", lane: "otlp", traceId: "e".repeat(32) }).invoke(
    "find_task",
  );
  await seedLedger(client, db, [sdk, otel]);
  const at = otel.rows()[0].occurredAt!.toISOString();
  await client.query(
    `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, client_event_id, trace_id, ingest_source, payload)
     values ('88888888-8888-4888-8888-888888888888', $1, 'otlp_model_call', 's-otel', $2, $2, 'm-1', $3, 'otlp', '{"menu":["find_task"]}'::jsonb)`,
    [PROJECT_ID, at, "e".repeat(32)],
  );
  await client.query(
    `update trace_events set ingest_source = 'otlp', payload = '{"has_session": true}'::jsonb where session_id = 's-otel' and type <> 'otlp_model_call'`,
  );

  const counts = await loadSetupCounts(PROJECT_ID, WINDOW, db);
  assert.equal(counts.otel.modelCalls, 1);
  assert.equal(counts.otel.modelCallsWithMenu, 1);
  assert.equal(counts.otel.modelCallsWithPrompt, 0);
  assert.ok(counts.otel.toolRows >= 1);
  assert.equal(counts.otel.toolRowsWithSession, counts.otel.toolRows);
  assert.equal(counts.sdk.searches, 1);
  assert.equal(counts.sdk.searchesWithQuery, 1);
  assert.ok(counts.sdk.events >= 2);

  const setup = buildSetupFacts(counts);
  assert.deepEqual(setup.lanes, { sdk: true, otel: true });
  assert.equal(setup.facts.find((f) => f.key === "otel_content")?.status, "off");
});

test("setup counts name the rows a Braintrust import wrote, by their source id (RC-256)", async () => {
  const { client, db } = await setupDb();
  const live = new TurnFixture({ session: "s-live", lane: "otlp", traceId: "a".repeat(32) }).invoke(
    "find_task",
  );
  await seedLedger(client, db, [live]);
  const at = live.rows()[0].occurredAt!.toISOString();
  await client.query(
    `update trace_events set ingest_source = 'otlp', source_id = 'braintrust-import' where session_id = 's-live'`,
  );
  const insert = (id: string, clientEventId: string, sourceId: string) =>
    client.query(
      `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, client_event_id, trace_id, ingest_source, source_id, payload)
       values ($1, $2, 'otlp_model_call', 's-live', $3, $3, $4, $5, 'otlp', $6, '{}'::jsonb)`,
      [id, PROJECT_ID, at, clientEventId, "a".repeat(32), sourceId],
    );
  await insert("77777777-7777-4777-8777-777777777771", "m-bt", "braintrust-import");
  const imported = await loadSetupCounts(PROJECT_ID, WINDOW, db);
  assert.equal(
    imported.otel.braintrustImportRows,
    imported.otel.toolRows + imported.otel.modelCalls,
  );
  assert.equal(
    buildSetupFacts(imported).facts.some((f) => f.key === "otel_tool_definitions"),
    false,
  );

  await insert("77777777-7777-4777-8777-777777777772", "m-lf", "langfuse-import");
  const mixed = await loadSetupCounts(PROJECT_ID, WINDOW, db);
  assert.equal(mixed.otel.braintrustImportRows, mixed.otel.toolRows + mixed.otel.modelCalls - 1);
  assert.equal(
    buildSetupFacts(mixed).facts.find((f) => f.key === "otel_tool_definitions")?.status,
    "off",
  );
});
