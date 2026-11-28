import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { Pool } from "pg";
import { runMigrations } from "@/lib/platform/db/migrate";
import { MIGRATIONS_DIR } from "@/lib/platform/db/test-support";
import { createPgRqlExecutor, type RqlPool } from "../adapters/pg-executor";
import { compileRql, RQL_LIMITS, type RqlCompiled } from "../compile";
import { RQL_TABLES, type RqlTable } from "../domain/catalog";
import { createRqlGate, type RqlRunDeps, type RqlRunResult, runRql } from "../run";
import { pglitePool } from "./test-support";

/**
 * The wall of RQL against a real database: the views, the role, the read-only transaction, the
 * timeout and the gate. Every test runs on PGlite. With `RQL_TEST_DATABASE_URL` (a superuser of an
 * empty Postgres, which the file migrates) every test runs on Postgres too. PGlite enforces roles,
 * grants and READ ONLY, but not `statement_timeout`: the timeout test needs Postgres.
 */

interface Backend {
  name: string;
  /** A pool of superuser connections: seeding, and the RQL pool the runner uses. */
  pool(): Promise<RqlPool & { end(): Promise<void> }>;
  enforcesTimeout: boolean;
}

const NOW = new Date();
const HOUR = 3_600_000;

const BACKENDS: Backend[] = [
  { name: "pglite", pool: pglitePool, enforcesTimeout: false },
  ...(process.env.RQL_TEST_DATABASE_URL
    ? [{ name: "postgres", pool: postgresPool, enforcesTimeout: true }]
    : []),
];

for (const backend of BACKENDS) {
  describe(`RQL on ${backend.name}`, () => {
    test("a compiled query returns the rows of its project only", async () => {
      const { a, b, run } = await seeded(backend);
      const result = await run(a.project, "select trace_id from traces order by trace_id");
      assert.ok(result.ok, JSON.stringify(result));
      assert.deepEqual(result.rows, [[a.trace], [a.trace2]]);
      assert.ok(!JSON.stringify(result.rows).includes(b.trace));
    });

    test("the views alone isolate projects: raw SQL with no project filter", async () => {
      const { a, b, raw } = await seeded(backend);
      for (const view of ["events", "traces", "scores", "sessions", "users"]) {
        const rows = await raw(a.project, `select * from rql.${view}`);
        assert.ok(rows.length > 0, `${view} has rows of A`);
        assert.ok(!JSON.stringify(rows).includes(b.trace), `${view} has no row of B`);
        assert.ok(!JSON.stringify(rows).includes(b.project), `${view} has no id of B`);
      }
      const none = await raw("", "select * from rql.traces");
      assert.deepEqual(none, [], "no project setting, no row");
    });

    test("rql.scores joins a scorer of the same project only", async () => {
      const { a, b, pool, raw } = await seeded(backend);
      const client = await pool.connect();
      try {
        // A score of A that points at the scorer of B: the view must not name B's scorer.
        await client.query({
          text: `insert into trace_scores (scorer_id, trace_id, project_id, value, passed, trace_started_at)
                 select id, $2, $1, 0, false, now() - interval '1 hour'
                 from trace_scorers where project_id = $3`,
          values: [a.project, a.trace2, b.project],
        });
      } finally {
        client.release();
      }
      const rows = await raw(a.project, "select scorer_id, trace_id from rql.scores");
      assert.ok(rows.length > 0, "A still has its own score");
      assert.ok(!rows.some((row) => row[1] === a.trace2), JSON.stringify(rows));
    });

    test("the role cannot read a base table", async () => {
      const { a, runRaw } = await seeded(backend);
      for (const table of ["public.otel_spans", "public.otel_trace_summaries", "public.projects"]) {
        const result = await runRaw(a.project, `select * from ${table} limit $1::bigint`);
        assert.ok(!result.ok);
        assert.equal(result.error.code, "rql_permission_denied", table);
      }
    });

    test("a write fails: the runner's cursor reads only a SELECT", async () => {
      const { a, runRaw } = await seeded(backend);
      const result = await runRaw(
        a.project,
        "insert into rql.traces (trace_id) select 'x' where $1::bigint > 0",
      );
      assert.ok(!result.ok);
      assert.equal(result.error.code, "rql_query_failed");
    });

    test("a write fails: the transaction is read-only, even for a temp table the role may create", async () => {
      const { pool } = await seeded(backend);
      const client = await pool.connect();
      try {
        await client.query({ text: "begin read only" });
        await client.query({ text: "set local role ratel_rql" });
        await assert.rejects(
          client.query({ text: "create temp table rql_scratch (a int)" }),
          (error: { code?: string }) => error.code === "25006",
        );
        await client.query({ text: "rollback" });
      } finally {
        client.release();
      }
    });

    test("a write fails: the role alone has no write grant, even outside a read-only transaction", async () => {
      const { pool } = await seeded(backend);
      const client = await pool.connect();
      try {
        for (const statement of [
          "insert into rql.traces (trace_id) values ('x')",
          "delete from public.otel_spans",
          "create table rql.stolen (id int)",
          "create view rql.stolen as select 1",
        ]) {
          await client.query({ text: "begin" });
          await client.query({ text: "set local role ratel_rql" });
          await assert.rejects(
            client.query({ text: statement }),
            (error: { code?: string }) => error.code === "42501",
            statement,
          );
          await client.query({ text: "rollback" });
        }
      } finally {
        client.release();
      }
    });

    test("the runner sets the statement_timeout of the transaction", async () => {
      const { a, raw } = await seeded(backend);
      const rows = await raw(a.project, "select current_setting('statement_timeout')", 250);
      // Each fetch of the cursor gets what is left of the 250 ms.
      const [[setting]] = rows as [[string]];
      const ms = Number.parseInt(setting, 10);
      assert.ok(setting.endsWith("ms") && ms > 0 && ms <= 250, setting);
    });

    test("the timeout stops a slow query", {
      skip: backend.enforcesTimeout ? false : "PGlite does not enforce statement_timeout",
    }, async () => {
      const { a, runRaw } = await seeded(backend);
      const started = Date.now();
      const result = await runRaw(a.project, "select pg_sleep(5) where $1::bigint > 0", {
        timeoutMs: 100,
      });
      assert.ok(!result.ok);
      assert.equal(result.error.code, "rql_timeout");
      assert.ok(Date.now() - started < 4_000, "stopped well before the sleep ends");
    });

    test("one query over the parallel cap of a project is refused with a clear error", async () => {
      const { a, run } = await seeded(backend);
      const gate = createRqlGate();
      const max = RQL_LIMITS.parallelQueriesPerProject;
      const results = await Promise.all(
        Array.from({ length: max + 1 }, () =>
          run(a.project, "select trace_id from traces", { gate }),
        ),
      );
      const refused = results.filter((result) => !result.ok);
      assert.equal(results.filter((result) => result.ok).length, max);
      assert.equal(refused.length, 1);
      assert.ok(!refused[0].ok);
      assert.equal(refused[0].error.code, "rql_busy");
      assert.match(refused[0].error.message, new RegExp(`${max} queries at the same time`));
      assert.match(refused[0].error.fix, /run the query again/);
    });

    test("a query with no time filter reads the default window only", async () => {
      const { a, run } = await seeded(backend);
      const result = await run(a.project, "select trace_id from traces");
      assert.ok(result.ok);
      assert.ok(!JSON.stringify(result.rows).includes(a.oldTrace), "the 48-hour-old trace is out");
    });

    test("a row of each of the five views reads with a compiled query", async () => {
      const { a, run } = await seeded(backend);
      const cases: [string, unknown[][]][] = [
        [
          "select trace_id, type, status, cost_usd from events where span_id = 'aaaa000000000001'",
          [[a.trace, "llm_call", "error", 0.5]],
        ],
        [
          `select trace_id, has_error, input_tokens, models from traces where trace_id = '${a.trace}'`,
          [[a.trace, true, 10, ["claude-sonnet-5"]]],
        ],
        [
          "select scorer, scorer_kind, value, passed, session_id from scores",
          [["helpful", "check", 1, true, "sess-1"]],
        ],
        ["select session_id, user_id, trace_count from sessions", [["sess-1", "user-1", 2]]],
        ["select user_id, session_count, trace_count from users", [["user-1", 1, 2]]],
      ];
      for (const [query, rows] of cases) {
        const result = await run(a.project, query);
        assert.ok(result.ok, `${query}: ${JSON.stringify(result)}`);
        assert.deepEqual(result.rows, rows, query);
        assert.equal(result.truncated, false);
      }
    });

    test("events give exactly the five types, one per kind of span", async () => {
      const { a, run } = await seeded(backend);
      const result = await run(
        a.project,
        "select type, count(*) from events group by type order by type",
      );
      assert.ok(result.ok, JSON.stringify(result));
      assert.deepEqual(result.rows, [
        ["agent_run", 1],
        ["llm_call", 1],
        ["other", 1],
        ["search", 1],
        ["tool_call", 1],
      ]);
    });

    test("each view has the columns of the catalog, with the same names", async () => {
      const { pool } = await seeded(backend);
      const client = await pool.connect();
      try {
        const { rows } = await client.query({
          text: `select table_name, column_name from information_schema.columns
                 where table_schema = 'rql' order by table_name, ordinal_position`,
        });
        const viewColumns = (view: string) =>
          (rows as unknown as { table_name: string; column_name: string }[])
            .filter((row) => row.table_name === view)
            .map((row) => row.column_name);
        for (const table of RQL_TABLES) {
          const columns = viewColumns(table.view);
          assert.ok(!columns.includes("end_user_id"), `${table.view} aliases end_user_id`);
          if (table.grain === "rows") {
            assert.deepEqual(
              columns,
              table.columns.map((column) => column.name),
              table.view,
            );
            continue;
          }
          for (const source of totalsSourceColumns(table)) {
            assert.ok(columns.includes(source), `${table.view} has ${source}`);
          }
        }
      } finally {
        client.release();
      }
    });

    test("the result has typed columns, and no truncated mark when only its own LIMIT cuts it", async () => {
      const { a, run } = await seeded(backend);
      const cut = await run(
        a.project,
        "select trace_id, started_at from traces order by trace_id limit 1",
      );
      assert.ok(cut.ok);
      assert.deepEqual(cut.columns, [
        { name: "trace_id", type: "text" },
        { name: "started_at", type: "timestamp" },
      ]);
      assert.equal(cut.rows.length, 1);
      assert.equal(cut.rows[0][0], a.trace);
      assert.match(String(cut.rows[0][1]), /^\d{4}-\d{2}-\d{2}T.*Z$/);
      assert.equal(cut.truncated, false);
      const whole = await run(a.project, "select trace_id from traces limit 2");
      assert.ok(whole.ok);
      assert.equal(whole.truncated, false);
    });
  });
}

/** The view columns a totals table reads: its key, its time column and the names in its totals. */
function totalsSourceColumns(table: RqlTable): string[] {
  const quoted = table.columns.flatMap((column) =>
    [...(column.total ?? "").matchAll(/"([a-z_]+)"/g)].map((match) => match[1]),
  );
  return [...new Set([table.key ?? "", table.timeColumn, ...quoted])];
}

interface Seeded {
  a: { project: string; trace: string; trace2: string; oldTrace: string };
  b: { project: string; trace: string };
  pool: RqlPool;
  run(project: string, query: string, deps?: Partial<RqlRunDeps>): Promise<RqlRunResult>;
  runRaw(project: string, sql: string, deps?: Partial<RqlRunDeps>): Promise<RqlRunResult>;
  raw(project: string, sql: string, timeoutMs?: number): Promise<unknown[][]>;
}

async function seeded(backend: Backend): Promise<Seeded> {
  const pool = await backend.pool();
  after(() => pool.end());
  const a = {
    project: randomUUID(),
    trace: `a1${randomUUID().replaceAll("-", "").slice(2)}`,
    trace2: `a2${randomUUID().replaceAll("-", "").slice(2)}`,
    oldTrace: `a3${randomUUID().replaceAll("-", "").slice(2)}`,
  };
  const b = { project: randomUUID(), trace: `b1${randomUUID().replaceAll("-", "").slice(2)}` };
  await seed(pool, a, b);
  const executor = createPgRqlExecutor(pool);
  const quiet = { executor, gate: createRqlGate(), observe: async () => {} };
  return {
    a,
    b,
    pool,
    run(project, query, deps = {}) {
      const compiled = compileRql(query, { now: NOW });
      assert.ok(compiled.ok, `${query}: ${JSON.stringify(compiled)}`);
      return runRql(compiled, { projectId: project }, { ...quiet, ...deps });
    },
    runRaw(project, sql, deps = {}) {
      return runRql(rawCompiled(sql), { projectId: project }, { ...quiet, ...deps });
    },
    raw(project, sql, timeoutMs = 10_000) {
      return executor.execute({
        projectId: project,
        sql,
        params: [],
        timeoutMs,
        maxBytes: 1_000_000,
      });
    },
  };
}

/** A compiled query the compiler would never give: only the runner's own guards apply. */
function rawCompiled(sql: string): RqlCompiled {
  return {
    ok: true,
    sql,
    params: [10],
    limitParam: 0,
    columns: [{ name: "x", type: "text" }],
    table: "traces",
    window: { from: NOW.toISOString(), to: NOW.toISOString() },
    limit: 10,
    ownLimit: false,
    oneRow: false,
  };
}

async function seed(pool: RqlPool, a: Seeded["a"], b: Seeded["b"]): Promise<void> {
  const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();
  const client = await pool.connect();
  const q = (text: string, values: unknown[]) => client.query({ text, values });
  try {
    for (const [project, slug] of [
      [a.project, "a"],
      [b.project, "b"],
    ]) {
      await q("insert into projects (id, organization_id, name, slug) values ($1, $2, $3, $3)", [
        project,
        randomUUID(),
        `p-${slug}-${project.slice(0, 8)}`,
      ]);
    }
    const span = (
      project: string,
      trace: string,
      spanId: string,
      cls: string,
      status: number,
      operation: string | null = null,
    ) =>
      q(
        `insert into otel_spans (id, project_id, trace_id, span_id, name, kind, span_class,
           started_at, ended_at, duration_ms, status_code, operation_name, model, cost_usd,
           session_id, end_user_id, attributes)
         values ($1, $2, $3, $4, 'chat', 3, $5, $6, $6, 12, $7, $8, 'claude-sonnet-5', 0.5,
           'sess-1', 'user-1', '{}')`,
        [randomUUID(), project, trace, spanId, cls, at(1), status, operation],
      );
    await span(a.project, a.trace, "aaaa000000000001", "llm_call", 2, "chat");
    await span(a.project, a.trace, "aaaa000000000002", "tool", 1, "execute_tool");
    await span(a.project, a.trace, "aaaa000000000003", "ratel_search", 1);
    await span(a.project, a.trace, "aaaa000000000004", "other", 1, "invoke_agent");
    await span(a.project, a.trace, "aaaa000000000005", "other", 1);
    await span(b.project, b.trace, "bbbb000000000001", "llm_call", 1);
    const summary = (project: string, trace: string, hoursAgo: number, session: boolean) =>
      q(
        `insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error,
           input_tokens, output_tokens, cost_usd, models, session_id, end_user_id, spans_max_received_at)
         values ($1, $2, $3, 100, true, 10, 5, 0.5, '{claude-sonnet-5}', $4, $5, now())`,
        [project, trace, at(hoursAgo), session ? "sess-1" : null, session ? "user-1" : null],
      );
    await summary(a.project, a.trace, 1, true);
    await summary(a.project, a.trace2, 2, true);
    await summary(a.project, a.oldTrace, 48, true);
    await summary(b.project, b.trace, 1, true);
    for (const [project, trace] of [
      [a.project, a.trace],
      [b.project, b.trace],
    ]) {
      const scorer = randomUUID();
      await q(
        `insert into trace_scorers (id, project_id, name, kind, config, created_by, updated_by)
         values ($1, $2, 'helpful', 'check', '{}', 'test', 'test')`,
        [scorer, project],
      );
      await q(
        `insert into trace_scores (scorer_id, trace_id, project_id, value, passed, trace_started_at)
         values ($1, $2, $3, 1, true, $4)`,
        [scorer, trace, project, at(1)],
      );
    }
  } finally {
    client.release();
  }
}

let migrated: Promise<void> | undefined;

/** A pool on the Postgres of RQL_TEST_DATABASE_URL, migrated once per process. */
async function postgresPool(): Promise<RqlPool & { end(): Promise<void> }> {
  const url = process.env.RQL_TEST_DATABASE_URL as string;
  migrated ??= runMigrations({ url, migrationsFolder: MIGRATIONS_DIR, sslMode: "disable" });
  await migrated;
  return new Pool({ connectionString: url, max: 6 }) as unknown as RqlPool & {
    end(): Promise<void>;
  };
}
