import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { PROJECT_ID, setupDb } from "@/lib/readings/trace-signals/signals/integration-support";
import { loadShipmentWatches } from "./load";

/**
 * The watch reads a shipment's fix (kind and tools) and the spans around its
 * ship time: tool calls by tool, runs that call the fix's tools, and the
 * newest such traces.
 */

const SHIPPED = new Date("2026-11-17T12:00:00Z");
const NOW = new Date("2026-11-17T12:10:00Z");
const PROPOSAL = "33333333-3333-4333-8333-333333333333";
const SHIPMENT = "44444444-4444-4444-8444-444444444444";
const MIN = 60_000;

let spanN = 0;
async function span(
  client: PGlite,
  traceId: string,
  at: Date,
  fields: {
    cls: "tool" | "llm_call" | "other";
    tool?: string;
    ms?: number;
    error?: boolean;
    tokens?: number;
    root?: boolean;
  },
) {
  spanN += 1;
  const id = `00000000-0000-4000-8000-${spanN.toString().padStart(12, "0")}`;
  await client.query(
    `insert into otel_spans (id, project_id, trace_id, span_id, parent_span_id, name, kind, span_class, started_at, ended_at, duration_ms, status_code, input_tokens, output_tokens, attributes)
     values ($1, $2, $3, $4, $5, $6, 1, $7, $8, $8, $9, $10, $11, $12, $13)`,
    [
      id,
      PROJECT_ID,
      traceId,
      `s${spanN}`,
      fields.root ? null : "root",
      fields.tool ? `execute_tool ${fields.tool}` : fields.cls,
      fields.cls,
      at.toISOString(),
      fields.ms ?? 100,
      fields.error ? 2 : 0,
      fields.tokens ?? null,
      fields.tokens === undefined ? null : 0,
      JSON.stringify(fields.tool ? { "gen_ai.tool.name": fields.tool } : {}),
    ],
  );
}

/** One run: a root, a model call, and its tool calls. */
async function run(
  client: PGlite,
  traceId: string,
  at: Date,
  tools: readonly string[],
  opts: { error?: boolean; ms?: number } = {},
) {
  await span(client, traceId, at, { cls: "other", root: true });
  await span(client, traceId, at, { cls: "llm_call", tokens: 1_000 * (tools.length + 1) });
  for (const tool of tools)
    await span(client, traceId, at, { cls: "tool", tool, ms: opts.ms ?? 400, error: opts.error });
}

async function seed() {
  const { client, db } = await setupDb();
  await client.query(
    `insert into tool_craft_runs (id, project_id, trigger, status) values ('55555555-5555-4555-8555-555555555555', $1, 'manual', 'completed')`,
    [PROJECT_ID],
  );
  await client.query(
    `insert into tool_craft_proposals (id, run_id, project_id, kind, status, source_tool_ids, source_definitions, crafted, rationale, evidence)
     values ($1, '55555555-5555-4555-8555-555555555555', $2, 'enrich_response', 'pending', '{find_booking,lookup_reservation}', '[]', '{}', 'x', '{}')`,
    [PROPOSAL, PROJECT_ID],
  );
  await client.query(
    `insert into fix_shipments (id, project_id, fix_id, version, shipped_by, shipped_at) values ($1, $2, $3, '1.1.0', 'project:x', $4)`,
    [SHIPMENT, PROJECT_ID, `craft:${PROPOSAL}`, SHIPPED.toISOString()],
  );
  // Before: 3 runs, one through the old engine; one run with no fix tool.
  await run(client, "b1", new Date(SHIPPED.getTime() - 60 * MIN), [
    "find_booking",
    "lookup_reservation",
    "send_message",
  ]);
  await run(client, "b2", new Date(SHIPPED.getTime() - 50 * MIN), ["find_booking", "send_message"]);
  await run(client, "b3", new Date(SHIPPED.getTime() - 40 * MIN), ["find_booking"], {
    error: true,
  });
  await run(client, "b4", new Date(SHIPPED.getTime() - 30 * MIN), ["search_flights"]);
  // Older than the baseline window: not read.
  await run(client, "old", new Date(SHIPPED.getTime() - 8 * 24 * 60 * MIN), ["find_booking"]);
  // After: two runs, find_booking only.
  await run(client, "a1", new Date(SHIPPED.getTime() + 2 * MIN), ["find_booking", "send_message"], {
    ms: 500,
  });
  await run(client, "a2", new Date(SHIPPED.getTime() + 5 * MIN), ["find_booking"], { ms: 600 });
  return { client, db };
}

test("a shipped enrich fix: its tools before and after the ship, its runs, and its newest traces", async () => {
  const { db } = await seed();
  const [watch] = await loadShipmentWatches(PROJECT_ID, { now: NOW }, db);
  assert.ok(watch);
  assert.equal(watch.shipment.id, SHIPMENT);
  assert.equal(watch.shipment.fixKind, "enrich");
  assert.deepEqual(watch.shipment.tools, ["find_booking", "lookup_reservation"]);

  const find = watch.changed[0]!;
  assert.equal(find.toolId, "find_booking");
  assert.deepEqual([find.baseline.calls, find.baseline.errors], [3, 1]);
  assert.deepEqual([find.after.calls, find.after.errors, find.after.p50Ms], [2, 0, 550]);
  assert.deepEqual(watch.removed, [
    { toolId: "lookup_reservation", callsAfter: 0, baselineCalls: 1, flagged: false },
  ]);

  assert.equal(watch.runs.before.runs, 3);
  assert.equal(watch.runs.before.toolCallsPerRun, 2);
  assert.equal(watch.runs.after.runs, 2);
  assert.equal(watch.runs.after.toolCallsPerRun, 1.5);
  assert.equal(watch.runs.after.tokensPerRun, 2_500);
  assert.equal(watch.verdict.status, "watching");

  assert.deepEqual(
    watch.traces.map((trace) => trace.traceId),
    ["a2", "a1"],
  );
  assert.deepEqual(watch.traces[1]!.tools, ["find_booking"]);
});

test("a removed tool called after the ship flags the shipment and its trace", async () => {
  const { client, db } = await seed();
  await run(client, "a3", new Date(SHIPPED.getTime() + 6 * MIN), [
    "find_booking",
    "lookup_reservation",
  ]);
  const [watch] = await loadShipmentWatches(PROJECT_ID, { now: NOW, shipmentId: SHIPMENT }, db);
  assert.equal(watch!.verdict.status, "regressed");
  assert.equal(watch!.removed[0]!.callsAfter, 1);
  assert.equal(watch!.traces[0]!.traceId, "a3");
  assert.equal(watch!.traces[0]!.calledRemoved, true);
});

test("a shipment whose fix names no tool it can read has no watch; an unknown id has none either", async () => {
  const { client, db } = await seed();
  await client.query(
    `insert into fix_shipments (id, project_id, fix_id, version, shipped_by, shipped_at) values ('66666666-6666-4666-8666-666666666666', $1, 'intent:x', '1.2.0', 'project:x', $2)`,
    [PROJECT_ID, NOW.toISOString()],
  );
  const watches = await loadShipmentWatches(PROJECT_ID, { now: NOW }, db);
  assert.deepEqual(
    watches.map((watch) => watch.shipment.id),
    [SHIPMENT],
  );
  assert.deepEqual(await loadShipmentWatches(PROJECT_ID, { now: NOW, shipmentId: "nope" }, db), []);
});
