import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { RqlPool } from "../adapters/pg-executor";
import { compileRql } from "../compile";
import { pglitePool } from "./test-support";

/**
 * The views keep their project filter before any condition of the query. A plain view lets the
 * planner run the query's own WHERE on other projects' rows first: a condition that fails (a
 * division by zero) on one row of another project then tells a value of that project, one guess at
 * a time. The views are `security_barrier`, so the query's conditions see only the project's rows.
 */

const NOW = new Date();
const VIEWS = ["events", "traces", "scores", "sessions", "users", "prompts"];
const SECRET_MS = 7777;

let pool: RqlPool & { end(): Promise<void> };
const a = randomUUID();
const b = randomUUID();

before(async () => {
  pool = await pglitePool();
  const at = new Date(NOW.getTime() - 3_600_000).toISOString();
  const client = await pool.connect();
  const q = (text: string, values: unknown[]) => client.query({ text, values });
  try {
    for (const project of [a, b])
      await q("insert into projects (id, organization_id, name, slug) values ($1, $2, $3, $3)", [
        project,
        randomUUID(),
        `p-${project.slice(0, 8)}`,
      ]);
    const trace = (project: string, id: string, ms: number) =>
      q(
        `insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error,
           input_tokens, output_tokens, cost_usd, models, spans_max_received_at)
         values ($1, $2, $3, $4, false, 1, 1, 0.1, '{m}', now())`,
        [project, id, at, ms],
      );
    for (let i = 0; i < 50; i++) await trace(a, `a${i}`, 100 + i);
    await trace(b, "b-secret", SECRET_MS);
    // A captured prompt of each project: B's latency is the secret on the prompts view.
    const prompt = (project: string, latencyMs: number) =>
      q(
        `with e as (insert into events (project_id, received_at) values ($1, $2) returning id)
         insert into event_metrics (event_id, project_id, event_time, tokens_by_category, splits,
           latency_ms, categorizer_version)
         select id, $1, $2, '{"skills": 1}', '{}', $3, 1 from e`,
        [project, at, latencyMs],
      );
    for (let i = 0; i < 20; i++) await prompt(a, 100 + i);
    await prompt(b, SECRET_MS);
  } finally {
    client.release();
  }
});
after(() => pool.end());

test("each rql view is a security barrier", async () => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query({
      text: `select c.relname, c.reloptions from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'rql' and c.relkind = 'v' order by c.relname`,
    });
    assert.deepEqual(
      (rows as { relname: string; reloptions: string[] | null }[]).map(
        ({ relname, reloptions }) => [
          relname,
          reloptions?.includes("security_barrier=true") ?? false,
        ],
      ),
      [...VIEWS].sort().map((view) => [view, true]),
    );
  } finally {
    client.release();
  }
});

for (const [table, column] of [
  ["traces", "duration_ms"],
  ["prompts", "latency_ms"],
])
  test(`a failing condition on ${table} cannot read another project's values, on a sequential scan`, async () => {
    const outcomes = [];
    for (const guess of [SECRET_MS - 1, SECRET_MS]) {
      const compiled = compileRql(
        `select count(*) from ${table} where ${column} / (${column} - ${guess}) > 0`,
        { now: NOW },
      );
      assert.ok(compiled.ok);
      const client = await pool.connect();
      try {
        await client.query({ text: "begin read only" });
        // The plan of a project with a large share of the table.
        await client.query({ text: "set local enable_indexscan = off" });
        await client.query({ text: "set local enable_bitmapscan = off" });
        await client.query({ text: "set local role ratel_rql" });
        await client.query({ text: "select set_config('rql.project_id', $1, true)", values: [a] });
        const { rows } = await client.query({
          text: compiled.sql,
          values: compiled.params,
          rowMode: "array",
        });
        outcomes.push(JSON.stringify(rows));
      } catch (error) {
        outcomes.push(`error: ${(error as Error).message}`);
      } finally {
        await client.query({ text: "rollback" }).catch(() => {});
        client.release();
      }
    }
    assert.equal(outcomes[1], outcomes[0], "the guess of B's value changes nothing for A");
    assert.doesNotMatch(outcomes[1], /error/);
  });

test("the prompts view gives the rows of the project in rql.project_id only", async () => {
  const compiled = compileRql("select count(*), max(latency_ms) from prompts", { now: NOW });
  assert.ok(compiled.ok);
  const client = await pool.connect();
  try {
    await client.query({ text: "begin read only" });
    await client.query({ text: "set local role ratel_rql" });
    await client.query({ text: "select set_config('rql.project_id', $1, true)", values: [a] });
    const { rows } = await client.query({
      text: compiled.sql,
      values: compiled.params,
      rowMode: "array",
    });
    assert.deepEqual(rows, [[20, 119]]);
  } finally {
    await client.query({ text: "rollback" }).catch(() => {});
    client.release();
  }
});
