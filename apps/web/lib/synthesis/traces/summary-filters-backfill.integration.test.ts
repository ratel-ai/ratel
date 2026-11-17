import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { backfillTraceSummaryFilters } from "@/lib/synthesis/traces/summary-filters-backfill";

/**
 * RC-505 m1: summary rows written before migration 0097 carry the column
 * defaults (no models, tools, service or environment). The one-off backfill
 * recomputes them in (project_id, trace_id) batches, never through the sweep
 * cursor.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT_A = "11111111-1111-4111-8111-11111111111a";
const PROJECT_B = "11111111-1111-4111-8111-11111111111b";
const CUTOFF = new Date("2026-11-10T00:00:00.000Z");

type Db = Parameters<typeof backfillTraceSummaryFilters>[0];

test("the backfill fills the filter columns of rows older than the cutoff, a batch at a time", async () => {
  const { client, db } = await seeded();
  try {
    const batches: number[] = [];
    const result = await backfillTraceSummaryFilters(db, {
      before: CUTOFF,
      batchSize: 2,
      onBatch: (progress) => batches.push(progress.traces),
    });
    assert.deepEqual(result, { traces: 3, batches: 2 });
    assert.deepEqual(batches, [2, 3]);
    assert.deepEqual(await columns(client), [
      {
        trace: "a1",
        models: ["gpt-4o"],
        tools: ["lookup"],
        service: "support",
        environment: "prod",
      },
      { trace: "a2", models: ["claude"], tools: [], service: "support", environment: null },
      { trace: "b1", models: ["gpt-4o-mini"], tools: [], service: "billing", environment: null },
      // Written after the cutoff: the sweep already filled it, the backfill leaves it.
      { trace: "b2", models: [], tools: [], service: null, environment: null },
    ]);
  } finally {
    await client.close();
  }
});

test("a dry run counts the rows and writes nothing", async () => {
  const { client, db } = await seeded();
  try {
    const before = await columns(client);
    assert.deepEqual(
      await backfillTraceSummaryFilters(db, { before: CUTOFF, batchSize: 2, dryRun: true }),
      {
        traces: 3,
        batches: 2,
      },
    );
    assert.deepEqual(await columns(client), before);
  } finally {
    await client.close();
  }
});

test("a re-run with the same cutoff resumes: rows it already recomputed are skipped", async () => {
  const { client, db } = await seeded();
  try {
    await backfillTraceSummaryFilters(db, { before: CUTOFF });
    const after = await columns(client);
    assert.deepEqual(await backfillTraceSummaryFilters(db, { before: CUTOFF }), {
      traces: 0,
      batches: 0,
    });
    assert.deepEqual(await columns(client), after);
  } finally {
    await client.close();
  }
});

async function seeded(): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Org', 'org');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT_A}', '${ORG}', 'A', 'a'), ('${PROJECT_B}', '${ORG}', 'B', 'b');
  `);
  await spans(client, [
    [
      PROJECT_A,
      "a1",
      "s1",
      null,
      "invoke_agent",
      "other",
      null,
      "support",
      { "deployment.environment.name": "prod" },
    ],
    [PROJECT_A, "a1", "s2", "s1", "chat", "llm_call", "gpt-4o", "support", {}],
    [PROJECT_A, "a1", "s3", "s1", "execute_tool lookup", "tool", null, "support", {}],
    [PROJECT_A, "a2", "s4", null, "chat", "llm_call", "claude", "support", {}],
    [PROJECT_B, "b1", "s5", null, "chat", "llm_call", "gpt-4o-mini", "billing", {}],
    [PROJECT_B, "b2", "s6", null, "chat", "llm_call", "gpt-4o", "billing", {}],
  ]);
  // Summary rows as migration 0097 leaves them: the new columns at their defaults.
  const old = new Date(CUTOFF.getTime() - 86_400_000).toISOString();
  const fresh = new Date(CUTOFF.getTime() + 60_000).toISOString();
  await client.exec(`
    insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error, input_tokens, output_tokens, cost_usd, spans_max_received_at, updated_at) values
      ('${PROJECT_A}', 'a1', '${old}', 1, false, 0, 0, 0, '${old}', '${old}'),
      ('${PROJECT_A}', 'a2', '${old}', 1, false, 0, 0, 0, '${old}', '${old}'),
      ('${PROJECT_B}', 'b1', '${old}', 1, false, 0, 0, 0, '${old}', '${old}'),
      ('${PROJECT_B}', 'b2', '${old}', 1, false, 0, 0, 0, '${old}', '${fresh}');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as Db };
}

type SpanRow = [
  string,
  string,
  string,
  string | null,
  string,
  string,
  string | null,
  string,
  Record<string, string>,
];

async function spans(client: PGlite, rows: SpanRow[]): Promise<void> {
  for (const [
    index,
    [projectId, traceId, spanId, parent, name, spanClass, model, service, attributes],
  ] of rows.entries()) {
    await client.query(
      `insert into otel_spans (id, project_id, trace_id, span_id, parent_span_id, name, kind, span_class, started_at, ended_at, duration_ms, status_code, model, service_name, attributes)
       values ($1, $2, $3, $4, $5, $6, 1, $7, now(), now(), 1, 0, $8, $9, $10)`,
      [
        `c0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        projectId,
        traceId,
        spanId,
        parent,
        name,
        spanClass,
        model,
        service,
        JSON.stringify(attributes),
      ],
    );
  }
}

async function columns(client: PGlite) {
  const { rows } = await client.query<{
    trace: string;
    models: string[];
    tools: string[];
    service: string | null;
    environment: string | null;
  }>(
    `select trace_id as trace, models, tools, service_name as service, environment
     from otel_trace_summaries order by trace_id`,
  );
  return rows;
}
