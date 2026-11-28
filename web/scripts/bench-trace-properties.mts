/**
 * RTL-395 benchmark: where the values of indexed trace properties are stored (ADR-0012).
 *
 *   DATABASE_URL=postgres://postgres:postgres@localhost:55495/ratel \
 *     pnpm --filter @ratel/platform exec tsx scripts/bench-trace-properties.mts
 *
 *   --traces <n>     traces in the fixture (default 3000000)
 *   --projects <n>   projects (default 20); the first holds a third of the traces
 *   --runs <n>       timed runs of each query, after one warm-up (default 5)
 *   --keep           keep the bench schema (default: drop it at the end)
 *
 * It builds the two candidate designs side by side in a schema of its own (`bench_rtl395`), with
 * generate_series SQL and no app code:
 *
 * - `summaries.properties`: a jsonb column on a trace summary shaped like `otel_trace_summaries`,
 *   with one GIN index (`jsonb_path_ops`);
 * - `trace_properties (project_id, key, value, started_at, trace_id)`: one row per value, with one
 *   btree index on `(project_id, key, value, started_at)`.
 *
 * Every trace carries four properties: organization (2000 values, skewed), release (20), plan (5)
 * and region (50). It then times, on the largest project, a filter on one selective organization
 * over 30 days and over 12 months, a group-by on release, and the top 50 organizations, and prints
 * the median of the timed runs. Refuses a database that is not on this machine.
 */
import { parseArgs } from "node:util";
import pg from "pg";

const { values: args } = parseArgs({
  options: {
    traces: { type: "string", default: "3000000" },
    projects: { type: "string", default: "20" },
    runs: { type: "string", default: "5" },
    keep: { type: "boolean", default: false },
  },
});
const TRACES = Number(args.traces);
const PROJECTS = Number(args.projects);
const RUNS = Number(args.runs);
const SCHEMA = "bench_rtl395";
const DAY = "interval '1 day'";

interface Query {
  name: string;
  jsonb: string;
  table: string;
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host))
    throw new Error(`refusing ${host}: run the benchmark on a local database`);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const built = await timed(() => build(client));
    console.log(`fixture: ${TRACES} traces in ${PROJECTS} projects, built in ${seconds(built)}`);
    console.log(await sizes(client));
    const hot = await scalar(client, `select project_id from ${SCHEMA}.projects order by n desc limit 1`);
    const selective = await scalar(
      client,
      `select properties->>'organization' from ${SCHEMA}.summaries
       where project_id = '${hot}' group by 1 order by abs(count(*) - 500) limit 1`,
    );
    const hotCount = await scalar(client, `select n from ${SCHEMA}.projects where project_id = '${hot}'`);
    console.log(`largest project: ${hotCount} traces; selective organization: ${selective}`);
    const rows: Array<{ query: string; jsonb: number; table: number; rows: string }> = [];
    for (const query of queries(String(hot), String(selective))) {
      const jsonb = await median(client, query.jsonb);
      const table = await median(client, query.table);
      rows.push({ query: query.name, jsonb: jsonb.ms, table: table.ms, rows: `${jsonb.rows}/${table.rows}` });
    }
    console.log("\nmedian ms of", RUNS, "warm runs");
    console.table(rows);
    for (const query of queries(String(hot), String(selective)).slice(0, 1)) {
      console.log(`\nplan, ${query.name}, jsonb:`);
      console.log(await plan(client, query.jsonb));
      console.log(`plan, ${query.name}, table:`);
      console.log(await plan(client, query.table));
    }
  } finally {
    if (!args.keep) await client.query(`drop schema if exists ${SCHEMA} cascade`);
    await client.end();
  }
}

/** The fixture: one third of the traces in the first project, the rest spread evenly. */
async function build(client: pg.Client): Promise<void> {
  await client.query(`drop schema if exists ${SCHEMA} cascade; create schema ${SCHEMA}`);
  await client.query(`
    create table ${SCHEMA}.projects as
    select gen_random_uuid() as project_id, i as ordinal,
      (case when i = 0 then ${Math.floor(TRACES / 3)}
        else ${Math.floor((TRACES - Math.floor(TRACES / 3)) / (PROJECTS - 1))} end)::bigint as n
    from generate_series(0, ${PROJECTS - 1}) i`);
  await client.query(`
    create table ${SCHEMA}.summaries (
      project_id uuid not null, trace_id text not null, started_at timestamptz not null,
      duration_ms double precision not null, has_error boolean not null,
      input_tokens bigint not null, output_tokens bigint not null, cost_usd numeric(18,6) not null,
      models text[] not null, service_name text, environment text, session_id text, end_user_id text,
      spans_max_received_at timestamptz not null, updated_at timestamptz not null default now(),
      properties jsonb not null default '{}'::jsonb,
      primary key (project_id, trace_id))`);
  await client.query(`
    insert into ${SCHEMA}.summaries
    select p.project_id, md5(p.ordinal || ':' || g), started, 50 + random() * 5000, random() < 0.03,
      (random() * 4000)::bigint, (random() * 800)::bigint, (random() * 0.05)::numeric(18,6),
      array['model-' || (g % 4)], 'service-' || (g % 3), 'production', 'session-' || (g / 7), 'user-' || (g % 5000),
      started, now(),
      jsonb_build_object(
        'organization', 'org-' || lpad(floor(power(random(), 2) * 2000)::text, 4, '0'),
        'release', 'v1.' || (g % 20),
        'plan', (array['free','plus','pro','team','enterprise'])[1 + g % 5],
        'region', 'region-' || (g % 50))
    from ${SCHEMA}.projects p,
      lateral generate_series(1, p.n) g,
      lateral (select now() - (random() + g * 0) * 365 * ${DAY} as started) t`);
  await client.query(`
    create index on ${SCHEMA}.summaries (project_id, started_at);
    create index summaries_properties_idx on ${SCHEMA}.summaries using gin (properties jsonb_path_ops)`);
  await client.query(`
    create table ${SCHEMA}.trace_properties (
      project_id uuid not null, key text not null, value text not null,
      started_at timestamptz not null, trace_id text not null)`);
  await client.query(`
    insert into ${SCHEMA}.trace_properties
    select s.project_id, e.key, e.value, s.started_at, s.trace_id
    from ${SCHEMA}.summaries s, lateral jsonb_each_text(s.properties) e`);
  await client.query(`
    create index trace_properties_idx on ${SCHEMA}.trace_properties (project_id, key, value, started_at)`);
  await client.query(`vacuum analyze ${SCHEMA}.summaries`);
  await client.query(`vacuum analyze ${SCHEMA}.trace_properties`);
}

/** The four reads, each over 30 days and 12 months, in both designs. */
function queries(project: string, organization: string): Query[] {
  const out: Query[] = [];
  for (const [label, days] of [
    ["30 days", 30],
    ["12 months", 365],
  ] as const) {
    const window = `started_at >= now() - ${days} * ${DAY}`;
    const s = `s.project_id = '${project}' and s.${window}`;
    const p = `p.project_id = '${project}' and p.${window}`;
    out.push(
      {
        name: `filter organization = value, ${label}`,
        jsonb: `select count(*), avg(s.duration_ms) from ${SCHEMA}.summaries s
          where ${s} and s.properties @> '{"organization":"${organization}"}'`,
        table: `select count(*), avg(s.duration_ms) from ${SCHEMA}.trace_properties p
          join ${SCHEMA}.summaries s on s.project_id = p.project_id and s.trace_id = p.trace_id
          where ${p} and p.key = 'organization' and p.value = '${organization}'`,
      },
      {
        name: `filter, newest 50 traces, ${label}`,
        jsonb: `select s.trace_id, s.started_at from ${SCHEMA}.summaries s
          where ${s} and s.properties @> '{"organization":"${organization}"}'
          order by s.started_at desc limit 50`,
        table: `select p.trace_id, p.started_at from ${SCHEMA}.trace_properties p
          where ${p} and p.key = 'organization' and p.value = '${organization}'
          order by p.started_at desc limit 50`,
      },
      {
        name: `group by release (count, avg duration), ${label}`,
        jsonb: `select s.properties->>'release' as v, count(*), avg(s.duration_ms) from ${SCHEMA}.summaries s
          where ${s} group by 1`,
        table: `select p.value, count(*), avg(s.duration_ms) from ${SCHEMA}.trace_properties p
          join ${SCHEMA}.summaries s on s.project_id = p.project_id and s.trace_id = p.trace_id
          where ${p} and p.key = 'release' group by 1`,
      },
      {
        name: `top 50 organizations, ${label}`,
        jsonb: `select s.properties->>'organization' as v, count(*) from ${SCHEMA}.summaries s
          where ${s} and s.properties ? 'organization' group by 1 order by 2 desc limit 50`,
        table: `select p.value, count(*) from ${SCHEMA}.trace_properties p
          where ${p} and p.key = 'organization' group by 1 order by 2 desc limit 50`,
      },
    );
  }
  return out;
}

async function median(client: pg.Client, text: string): Promise<{ ms: number; rows: number }> {
  let rows = 0;
  await client.query(text);
  const times: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    const started = performance.now();
    rows = (await client.query(text)).rowCount ?? 0;
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return { ms: Math.round(times[Math.floor(times.length / 2)]! * 10) / 10, rows };
}

async function plan(client: pg.Client, text: string): Promise<string> {
  const result = await client.query(`explain (analyze, buffers) ${text}`);
  return result.rows.map((row) => `  ${row["QUERY PLAN"]}`).join("\n");
}

async function sizes(client: pg.Client): Promise<string> {
  const result = await client.query(`
    select relname, pg_size_pretty(pg_total_relation_size(c.oid)) as total,
      pg_size_pretty(pg_relation_size(c.oid)) as heap
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = '${SCHEMA}' and c.relkind in ('r', 'i') order by relname`);
  return result.rows.map((row) => `  ${row.relname}: ${row.total} (own ${row.heap})`).join("\n");
}

async function scalar(client: pg.Client, text: string): Promise<unknown> {
  const result = await client.query(text);
  return Object.values(result.rows[0] ?? {})[0];
}

async function timed(run: () => Promise<void>): Promise<number> {
  const started = performance.now();
  await run();
  return performance.now() - started;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`;
}

main().catch((err) => {
  console.error(`benchmark failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
