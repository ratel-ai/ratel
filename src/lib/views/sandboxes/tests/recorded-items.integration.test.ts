import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { SandboxDb } from "../adapters/pg-store";
import { readRecordedItems, readTraceMetrics } from "../adapters/recorded-items";

/**
 * Recorded items and run metrics against real PGlite: a sandbox's production item
 * calls of the last 30 days with their input and recorded reply (from
 * `events.payload`), and the tokens, cost and latency of a playground run's
 * trace.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJ = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJ = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-11-20T12:00:00Z");
const TRACE = "7b55d114b56c0667506050ec608264fd";

async function setup(): Promise<{ client: PGlite; db: SandboxDb }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJ}', '${ORG}', 'A', 'a'), ('${OTHER_PROJ}', '${ORG}', 'B', 'b');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as SandboxDb };
}

interface SpanRow {
  spanId: string;
  traceId?: string;
  parent?: string | null;
  project?: string;
  startedAt: string;
  attributes: Record<string, unknown>;
  durationMs?: number;
  tokens?: [number, number];
  cost?: string | null;
}

async function span(client: PGlite, row: SpanRow): Promise<void> {
  await client.query(
    `insert into otel_spans (id, project_id, trace_id, span_id, parent_span_id, name, kind, span_class, started_at, ended_at, duration_ms, status_code, attributes, input_tokens, output_tokens, cost_usd)
     values ($1, $2, $3, $4, $5, 'chat claude-sonnet-5-5', 3, 'llm_call', $6, $6, $7, 0, $8, $9, $10, $11)`,
    [
      randomUUID(),
      row.project ?? PROJ,
      row.traceId ?? TRACE,
      row.spanId,
      row.parent ?? null,
      row.startedAt,
      row.durationMs ?? 1,
      JSON.stringify(row.attributes),
      row.tokens?.[0] ?? null,
      row.tokens?.[1] ?? null,
      row.cost ?? null,
    ],
  );
}

async function reply(client: PGlite, spanId: string, text: string): Promise<void> {
  const payload = {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    ts: "2026-11-19T10:00:00Z",
    messages: [{ role: "user", content: "label" }],
    input_message_count: 1,
    output: [{ role: "assistant", content: [{ type: "text", text }] }],
  };
  await client.query(
    `insert into events (project_id, trace_id, span_id, payload) values ($1, $2, $3, $4)`,
    [PROJ, TRACE, spanId, JSON.stringify(payload)],
  );
}

const item = (workflowId: string, extra: Record<string, unknown> = {}) => ({
  "ratel.sandbox.id": "workflow-label",
  "ratel.sandbox.input": JSON.stringify({ workflowId }),
  ...extra,
});

test("recorded items are the sandbox's production item calls of the last 30 days, newest first, with input and reply", async () => {
  const { client, db } = await setup();
  await span(client, {
    spanId: "a1",
    startedAt: "2026-11-18T10:00:00Z",
    attributes: item("wf-old"),
  });
  await span(client, {
    spanId: "a2",
    startedAt: "2026-11-19T10:00:00Z",
    attributes: item("wf-new"),
  });
  await reply(client, "a2", '{"name":"Refunds"}');
  await span(client, {
    spanId: "p1",
    startedAt: "2026-11-19T11:00:00Z",
    attributes: item("wf-play", { "deployment.environment.name": "playground" }),
  });
  await span(client, {
    spanId: "o1",
    startedAt: "2026-11-19T11:00:00Z",
    attributes: { ...item("wf-x"), "ratel.sandbox.id": "topic-place" },
  });
  await span(client, {
    spanId: "x1",
    startedAt: "2026-11-19T11:00:00Z",
    project: OTHER_PROJ,
    attributes: item("wf-other"),
  });
  await span(client, {
    spanId: "z1",
    startedAt: "2026-10-01T10:00:00Z",
    attributes: item("wf-too-old"),
  });
  await span(client, {
    spanId: "r1",
    startedAt: "2026-11-19T11:00:00Z",
    attributes: { "ratel.sandbox.id": "workflow-label" },
  });

  const items = await readRecordedItems(db, {
    projectId: PROJ,
    sandboxId: "workflow-label",
    now: NOW,
  });

  assert.deepEqual(
    items.map((i) => [i.spanId, i.traceId, i.input, i.recordedOutput]),
    [
      ["a2", TRACE, { workflowId: "wf-new" }, { name: "Refunds" }],
      ["a1", TRACE, { workflowId: "wf-old" }, null],
    ],
  );
  assert.equal(items[0]!.startedAt.toISOString(), "2026-11-19T10:00:00.000Z");
});

test("recorded items can be read by span id, and an unknown or playground span is left out", async () => {
  const { client, db } = await setup();
  await span(client, { spanId: "a1", startedAt: "2026-11-18T10:00:00Z", attributes: item("wf-1") });
  await span(client, { spanId: "a2", startedAt: "2026-11-19T10:00:00Z", attributes: item("wf-2") });
  await span(client, {
    spanId: "p1",
    startedAt: "2026-11-19T11:00:00Z",
    attributes: item("wf-play", { "deployment.environment.name": "playground" }),
  });

  const items = await readRecordedItems(db, {
    projectId: PROJ,
    sandboxId: "workflow-label",
    now: NOW,
    spanIds: ["a1", "p1", "nope"],
  });

  assert.deepEqual(
    items.map((i) => i.spanId),
    ["a1"],
  );
});

test("an input that is not JSON stays as its text", async () => {
  const { client, db } = await setup();
  await span(client, {
    spanId: "a1",
    startedAt: "2026-11-18T10:00:00Z",
    attributes: { "ratel.sandbox.id": "workflow-label", "ratel.sandbox.input": "{cut" },
  });
  const [only] = await readRecordedItems(db, {
    projectId: PROJ,
    sandboxId: "workflow-label",
    now: NOW,
  });
  assert.equal(only?.input, "{cut");
});

test("trace metrics add the trace's tokens and cost, and take the latency of its root", async () => {
  const { client, db } = await setup();
  const run = "2c33a169e1d648ce2fbb7f04432f1a16";
  await span(client, {
    spanId: "root",
    traceId: run,
    startedAt: "2026-11-20T10:00:00Z",
    attributes: {},
    durationMs: 2729,
  });
  await span(client, {
    spanId: "c1",
    traceId: run,
    parent: "root",
    startedAt: "2026-11-20T10:00:00Z",
    attributes: {},
    tokens: [1601, 70],
    cost: "0.003902",
  });
  await span(client, {
    spanId: "c2",
    traceId: run,
    parent: "root",
    startedAt: "2026-11-20T10:00:01Z",
    attributes: {},
    tokens: [100, 10],
    cost: "0.000100",
  });

  assert.deepEqual(await readTraceMetrics(db, { projectId: PROJ, traceId: run }), {
    spans: 3,
    inputTokens: 1701,
    outputTokens: 80,
    costUsd: 0.004002,
    latencyMs: 2729,
  });
  assert.deepEqual(await readTraceMetrics(db, { projectId: PROJ, traceId: "f".repeat(32) }), {
    spans: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    latencyMs: null,
  });
});
