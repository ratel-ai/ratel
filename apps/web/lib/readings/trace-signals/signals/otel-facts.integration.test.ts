import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { listClosedTurnsPage } from "@/lib/ledger/closed-turns";
import { turn } from "@/lib/ledger/test-support";
import { loadAnalysisContext } from "@/lib/readings/trace-signals/signals/analysis-context";
import { computeSignals, signalWindow } from "@/lib/readings/trace-signals/signals/compute";
import {
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { linkRunsPage } from "@/lib/readings/trace-signals/signals/linked-runs-query";
import { loadOtelFacts } from "@/lib/readings/trace-signals/signals/otel-facts-query";
import { times } from "@/lib/readings/trace-signals/signals/test-fixtures";

/**
 * The OTel side table against a real schema: which `trace_events` rows the
 * read takes (OTLP-derived, in the window, carrying a fact), how the payload
 * bits parse, and a whole run that turns them into OTel signals.
 */

const START = new Date("2026-09-01T09:00:00Z");
const WINDOW = { start: new Date("2026-08-31T00:00:00Z"), end: new Date("2026-09-02T00:00:00Z") };
const OTHER_PROJECT = "33333333-3333-4333-8333-333333333333";

async function insertModelCall(
  client: PGlite,
  traceId: string,
  n: number,
  opts: { at?: Date; project?: string; menu?: unknown } = {},
) {
  const payload = JSON.stringify({
    type: "otlp_model_call",
    derived_from: "otlp",
    ...(opts.menu !== undefined ? { menu: opts.menu } : {}),
  });
  await client.query(
    `insert into trace_events (id, project_id, type, occurred_at, received_at, ingest_source, client_event_id, trace_id,
       input_tokens, output_tokens, payload)
     values (gen_random_uuid(), $1, 'otlp_model_call', $2, $2, 'otlp', $3, $4, 100, 10, $5::jsonb)`,
    [
      opts.project ?? PROJECT_ID,
      (opts.at ?? START).toISOString(),
      `otlp:model:${traceId}:${n}`,
      traceId,
      payload,
    ],
  );
}

/**
 * 14 traces where `a` fails and `b` runs next (its result captured empty in 4,
 * so 10 are switches), 18 where `a` alone works. The 14 take 12 model calls each.
 */
async function seedOtelProject(
  client: PGlite,
  db: Parameters<typeof seedLedger>[1],
): Promise<void> {
  const switches = times(14, (i) =>
    turn({ lane: "otlp", traceId: `sw-${i}`, session: `sw-${i}` })
      .error("a")
      .end("b"),
  );
  const plain = times(18, (i) =>
    turn({ lane: "otlp", traceId: `ok-${i}`, session: `ok-${i}` }).end("a"),
  );
  await seedLedger(client, db, [...switches, ...plain]);
  await client.exec(`
    update trace_events set ingest_source = 'otlp', payload = '{"derived_from":"otlp"}'::jsonb;
    update trace_events set error_message = 'timeout' where type = 'invoke_error';
    update trace_events set payload = '{"derived_from":"otlp","result_empty":true}'::jsonb
      where tool_id = 'b' and trace_id in ('sw-0', 'sw-1', 'sw-2', 'sw-3');
    update trace_events set payload = '{"derived_from":"otlp","result_empty":"true"}'::jsonb
      where tool_id = 'b' and trace_id = 'sw-4';
  `);
  for (let i = 0; i < 14; i++)
    for (let n = 0; n < 12; n++) await insertModelCall(client, `sw-${i}`, n, { menu: ["a", "b"] });
  for (let i = 0; i < 18; i++)
    for (let n = 0; n < 2; n++) await insertModelCall(client, `ok-${i}`, n, { menu: ["a", "b"] });
}

test("the OTel facts read takes OTLP rows with a fact, in the window, of this project only", async () => {
  const { client, db } = await setupDb();
  await client.exec(`insert into projects (id, organization_id, name, slug)
    select '${OTHER_PROJECT}', organization_id, 'Other', 'other' from projects where id = '${PROJECT_ID}'`);
  await seedOtelProject(client, db);
  await insertModelCall(client, "sw-0", 99, { at: new Date("2026-07-01T00:00:00Z") });
  await insertModelCall(client, "sw-0", 98, { project: OTHER_PROJECT });
  await insertModelCall(client, "odd-menu", 0, { menu: "not a list" });
  await client.exec(
    `update trace_events set ingest_source = 'runtime' where tool_id = 'a' and trace_id = 'ok-0'`,
  );

  const facts = await loadOtelFacts(PROJECT_ID, WINDOW, db);
  assert.ok(facts);
  const steps = [...facts.stepFacts.values()];
  assert.equal(
    steps.filter((s) => s.errorType === "timeout").length,
    14,
    "every failed call, by its error type",
  );
  assert.equal(steps.filter((s) => s.resultEmpty === true).length, 4);
  assert.equal(steps.length, 18, "plain ok calls and a non-boolean result bit add nothing");
  assert.equal(
    facts.traces.get("sw-0")?.modelCalls,
    12,
    "outside the window and other projects are left out",
  );
  assert.equal(facts.traces.get("sw-0")?.inputTokens, 1_200);
  assert.deepEqual([...(facts.traces.get("sw-0")?.menus ?? [])].sort(), ["a", "b"]);
  assert.equal(facts.traces.get("odd-menu")?.menuCalls, 0, "a menu that is not a list is no menu");
  assert.equal(facts.traces.size, 33);

  const capped = await loadOtelFacts(PROJECT_ID, WINDOW, db, 5);
  assert.equal(
    capped!.stepFacts.size + [...capped!.traces.values()].reduce((n, t) => n + t.modelCalls, 0),
    5,
  );
  await client.close();
});

test("a run over the stored ledger maps turns to traces and finds the OTel signals", async () => {
  const { client, db } = await setupDb();
  await seedOtelProject(client, db);
  const page = await listClosedTurnsPage(
    PROJECT_ID,
    { from: WINDOW.start, to: WINDOW.end, after: null },
    db,
  );
  assert.ok(
    page.turns.every((t) => t.turnKey?.startsWith("otlp:")),
    "turns carry their trace key",
  );

  const window = signalWindow(WINDOW.end, 7);
  const { result } = await computeSignals(PROJECT_ID, window, {
    listPage: (p, range, _db, limit) => listClosedTurnsPage(p, range, db, limit),
    loadContext: (p, w) => loadAnalysisContext(p, w, db),
    linkPage: (p, turns) => linkRunsPage(p, turns, db),
  });
  const byKind = new Map(result.signals.map((s) => [s.kind, s]));
  assert.equal(byKind.get("tool_switch")?.subjectKey, "a>b");
  assert.equal(
    byKind.get("tool_switch")?.metrics.k,
    10,
    "a switch to an empty result is no switch",
  );
  assert.equal(byKind.get("tool_switch")?.metrics.n, 32);
  assert.equal(byKind.get("long_turn")?.metrics.k, 14);
  assert.equal(byKind.get("long_turn")?.metrics.threshold, 8);
  assert.ok(result.measured.has("empty_result"));
  assert.ok(result.measured.has("unused_tool"));
  await client.close();
});
