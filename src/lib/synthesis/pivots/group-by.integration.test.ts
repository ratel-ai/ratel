import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { getPivotGroupBy, PIVOT_GROUP_LIMIT } from "@/lib/synthesis/pivots/group-by";

/**
 * RC-886: the Overview group-by of one pivot over `otel_trace_summaries`.
 * Seeded in the window: acme 3 runs (1 failed; 100, 200, 300 ms; $0.10 each),
 * globex 2 runs (0 failed; 50, 150 ms), initech 1 run (failed, 400 ms), and 2
 * runs with no client (one has another pivot only). One acme run is outside
 * the window and one is in another project.
 */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const T0 = Date.parse("2026-11-02T09:00:00.000Z");
const WINDOW = { since: new Date(T0 - 86_400_000), until: new Date(T0 + 86_400_000) };

type Seed = {
  project?: string;
  at?: number;
  dims: Record<string, string>;
  ms: number;
  error?: boolean;
  cost?: number;
};

test("per value: runs, error rate, p50 and cost, most runs first, then the (none) row", async () => {
  const { client, db } = await seeded([
    { dims: { client: "acme" }, ms: 100, cost: 0.1 },
    { dims: { client: "acme" }, ms: 200, cost: 0.1, error: true },
    { dims: { client: "acme" }, ms: 300, cost: 0.1 },
    { dims: { client: "globex" }, ms: 50, cost: 0.2 },
    { dims: { client: "globex" }, ms: 150, cost: 0.3 },
    { dims: { client: "initech" }, ms: 400, cost: 1, error: true },
    { dims: {}, ms: 10 },
    { dims: { end_user: "u-1" }, ms: 30, error: true },
    { dims: { client: "acme" }, ms: 999, at: -3 * 86_400_000 },
    { project: OTHER_PROJECT_ID, dims: { client: "acme" }, ms: 999 },
  ]);
  try {
    const result = await getPivotGroupBy(PROJECT_ID, "client", WINDOW, db);
    assert.deepEqual(result.rows, [
      { kind: "value", value: "acme", runs: 3, errorRate: 1 / 3, p50Ms: 200, costUsd: 0.3 },
      { kind: "value", value: "globex", runs: 2, errorRate: 0, p50Ms: 100, costUsd: 0.5 },
      { kind: "value", value: "initech", runs: 1, errorRate: 1, p50Ms: 400, costUsd: 1 },
      { kind: "none", value: null, runs: 2, errorRate: 0.5, p50Ms: 20, costUsd: 0 },
    ]);
    assert.equal(result.totalRuns, 8);
  } finally {
    await client.close();
  }
});

test("past the top values the rest fold into Other, its p50 over its own runs", async () => {
  const { client, db } = await seeded([
    { dims: { client: "acme" }, ms: 100 },
    { dims: { client: "acme" }, ms: 100 },
    { dims: { client: "acme" }, ms: 100 },
    { dims: { client: "globex" }, ms: 200 },
    { dims: { client: "globex" }, ms: 200 },
    { dims: { client: "initech" }, ms: 300, error: true, cost: 0.5 },
    { dims: { client: "umbrella" }, ms: 500, cost: 0.25 },
    { dims: { client: "hooli" }, ms: 700 },
  ]);
  try {
    const result = await getPivotGroupBy(PROJECT_ID, "client", WINDOW, db, 2);
    assert.deepEqual(result.rows, [
      { kind: "value", value: "acme", runs: 3, errorRate: 0, p50Ms: 100, costUsd: 0 },
      { kind: "value", value: "globex", runs: 2, errorRate: 0, p50Ms: 200, costUsd: 0 },
      { kind: "other", value: null, runs: 3, errorRate: 1 / 3, p50Ms: 500, costUsd: 0.75 },
    ]);
    assert.equal(PIVOT_GROUP_LIMIT, 50);
  } finally {
    await client.close();
  }
});

test("an empty window has no rows", async () => {
  const { client, db } = await seeded([]);
  try {
    assert.deepEqual(await getPivotGroupBy(PROJECT_ID, "client", WINDOW, db), {
      rows: [],
      totalRuns: 0,
    });
  } finally {
    await client.close();
  }
});

async function seeded(rows: readonly Seed[]) {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as Parameters<typeof getPivotGroupBy>[3];
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent'),
      ('${OTHER_PROJECT_ID}', '${ORGANIZATION_ID}', 'Other', 'other');
  `);
  for (const [index, row] of rows.entries()) {
    const at = new Date(T0 + (row.at ?? 0) + index).toISOString();
    await client.query(
      `insert into otel_trace_summaries
        (project_id, trace_id, started_at, duration_ms, has_error, input_tokens, output_tokens, cost_usd, dims, spans_max_received_at)
       values ($1, $2, $3, $4, $5, 0, 0, $6, $7::jsonb, $3)`,
      [
        row.project ?? PROJECT_ID,
        `trace-${index}`,
        at,
        row.ms,
        row.error ?? false,
        row.cost ?? 0,
        JSON.stringify(row.dims),
      ],
    );
  }
  return { client, db };
}
