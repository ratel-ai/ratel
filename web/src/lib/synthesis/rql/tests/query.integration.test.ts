import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import {
  clustersQuery,
  flowQuery,
  funnelQuery,
  geographyQuery,
  metricQuery,
  QUERY_KINDS,
  type Query,
  type QueryKind,
  type SqlQuery,
  stepFlowQuery,
} from "@/lib/contracts/query";
import type { QueryScope } from "@/lib/synthesis/metrics/catalog";
import {
  type MetricsDb,
  metricSeams,
  QueryError,
  type QueryResult,
  runQuery,
} from "@/lib/synthesis/metrics/query";
import { PROJECT as OTHER_PROJECT, traceDatabase } from "@/lib/synthesis/metrics/trace-fixture";
import "@/lib/views/dashboards/clusters";
import "@/lib/views/scorers/metrics";
import { createPgRqlExecutor, type RqlPool } from "../adapters/pg-executor";
import { RQL_VERSION } from "../compile";
import { sqlQueryRunner } from "../query";
import { createRqlGate, type RqlRunDeps } from "../run";
import { pglitePool } from "./test-support";

/**
 * Kind `sql` of the query object through `runQuery`: the seam `synthesis/rql/query.ts` registers,
 * the window of the scope, the language version, and the errors as RQL wrote them. The other kinds
 * run on a database of their own.
 */

const NOW = new Date();
const HOUR = 3_600_000;
/** Three days: the trace of two days ago is in it, and outside the default RQL window of 24 hours. */
const SCOPE: QueryScope = { since: new Date(NOW.getTime() - 72 * HOUR), until: NOW };

/** Each kind but `sql`, with a query, the part of its result that reads the seed, and its value. */
const OTHER_KINDS: [QueryKind, Query, (result: QueryResult) => unknown, unknown][] = [
  [
    "metric",
    metricQuery("trace_count", "count"),
    (r) => r.kind === "metric" && r.series.map(({ total }) => total),
    [1],
  ],
  [
    "flow",
    flowQuery("tool"),
    (r) => r.kind === "flow" && r.edges.map(({ source, target }) => `${source}>${target}`),
    ["search>read"],
  ],
  ["step_flow", stepFlowQuery("tool"), (r) => r.kind === "step_flow" && r.total, 1],
  [
    "funnel",
    funnelQuery([
      { name: "Search", condition: { type: "tool", name: "search" } },
      { name: "Read", condition: { type: "tool", name: "read" } },
    ]),
    (r) => r.kind === "funnel" && r.steps.map(({ count }) => count),
    [1, 1],
  ],
  // No intent map is stored: the kind reads no trace, and gives the empty map.
  ["clusters", clustersQuery("asks"), (r) => r.kind === "clusters" && r.analyzedAt, null],
  [
    "geography",
    geographyQuery("trace_count", "count"),
    (r) => r.kind === "geography" && r.places.map(({ code }) => code),
    ["IT"],
  ],
];

let pool: RqlPool & { end(): Promise<void> };
const project = randomUUID();
const traces = [`q1${hex()}`, `q2${hex()}`];
/** The database of the other kinds: one trace that calls search, then read, from Italy. */
let others: Awaited<ReturnType<typeof traceDatabase>>;

before(async () => {
  pool = await pglitePool();
  await seed();
  others = await traceDatabase();
  await others.seed([
    {
      id: "t1",
      startedAt: new Date(NOW.getTime() - HOUR).toISOString(),
      root: { attributes: { "ratel.geo.country": "IT" } },
      spans: [{ tool: "search" }, { tool: "read" }],
    },
  ]);
});
after(async () => {
  await pool.end();
  await others.client.close();
});

describe("runQuery of kind sql", () => {
  test("it gives the table of the RQL runner, over the window of the scope", async () => {
    use();
    const result = await runQuery(
      project,
      sql("select trace_id, duration_ms from traces order by trace_id"),
      SCOPE,
      NO_DB,
    );
    assert.deepEqual(result, {
      kind: "sql",
      columns: [
        { name: "trace_id", type: "text" },
        { name: "duration_ms", type: "number" },
      ],
      rows: [
        [traces[0], 100],
        [traces[1], 100],
      ],
      truncated: false,
    });
  });

  test("a time condition in the text narrows the window of the scope", async () => {
    use();
    const result = await runQuery(
      project,
      sql(
        `select trace_id from traces where started_at >= '${new Date(NOW.getTime() - 24 * HOUR).toISOString()}'`,
      ),
      SCOPE,
      NO_DB,
    );
    assert.deepEqual(result.rows, [[traces[0]]]);
  });

  test("more rows than the query's own limit are cut, and the result is whole: no cap of Ratel cut it", async () => {
    const read = useCounted();
    const result = await runQuery(
      project,
      sql("select trace_id from traces order by trace_id limit 1"),
      SCOPE,
      NO_DB,
    );
    assert.deepEqual(result.rows, [[traces[0]]]);
    assert.equal(result.truncated, false);
    // The runner read one row more than the limit: the second trace was there.
    assert.deepEqual(read, [2]);
  });

  test("the other kinds are every kind but sql", () => {
    assert.deepEqual(
      OTHER_KINDS.map(([kind]) => kind),
      QUERY_KINDS.filter((kind) => kind !== "sql"),
    );
  });

  for (const [kind, query, read, expected] of OTHER_KINDS) {
    test(`kind ${kind} runs as before`, async () => {
      use();
      const result = await runQuery(OTHER_PROJECT, query, SCOPE, others.db);
      assert.equal(result.kind, kind);
      assert.deepEqual(read(result), expected);
    });
  }

  test("a compile error comes back as RQL wrote it", async () => {
    use();
    await assert.rejects(runQuery(project, sql("select * from spans"), SCOPE, NO_DB), (error) => {
      assert.ok(error instanceof QueryError);
      assert.equal(error.detail?.code, "unknown_table");
      assert.match(error.message, /spans/);
      assert.ok(error.detail?.fix);
      return true;
    });
  });

  test("a run error comes back as RQL wrote it", async () => {
    use({ run: { gate: createRqlGate(0) } });
    await assert.rejects(
      runQuery(project, sql("select trace_id from traces"), SCOPE, NO_DB),
      (error) => {
        assert.ok(error instanceof QueryError);
        assert.equal(error.detail?.code, "rql_busy");
        assert.ok(error.detail?.fix);
        return true;
      },
    );
  });

  test("a filter of the page or dashboard keeps the rows whose trace matches", async () => {
    use();
    const all = await runQuery(project, sql("select count(*) from traces"), SCOPE, NO_DB);
    const none = await runQuery(
      project,
      sql("select count(*) from traces"),
      { ...SCOPE, filter: { models: ["no such model"] } },
      NO_DB,
    );
    assert.deepEqual([all.rows, none.rows], [[[2]], [[0]]]);
  });
});

/** The runner asks for `limit + 1` rows: only the LIMIT changes, never a literal of equal value. */
describe("a literal of the value of the limit", () => {
  test("equal to the default limit, it filters with its own value", async () => {
    use();
    const result = await runQuery(
      project,
      sql("select trace_id from traces where duration_ms = 100 order by trace_id"),
      SCOPE,
      NO_DB,
    );
    assert.deepEqual(result.rows, [[traces[0]], [traces[1]]]);
    assert.equal(result.truncated, false);
  });

  test("equal to an explicit limit, it filters with its own value, and the limit reads one row more", async () => {
    const read = useCounted();
    const result = await runQuery(
      project,
      sql("select trace_id from traces where duration_ms / 100 = 1 order by trace_id limit 1"),
      SCOPE,
      NO_DB,
    );
    assert.deepEqual(result.rows, [[traces[0]]]);
    // The literal 1 filtered with its own value; the LIMIT alone became 2, so both traces were read.
    assert.deepEqual(read, [2]);
    assert.equal(result.truncated, false);
  });

  test("a literal after the LIMIT in the order of the parameters keeps its value", async () => {
    const read = useCounted();
    // The parameters are the window, 100, 1 (the LIMIT) and 5: the last one is not the LIMIT.
    const result = await runQuery(
      project,
      sql(
        "select trace_id from traces where duration_ms / 100 = 1 and output_tokens = 5 order by trace_id limit 1",
      ),
      SCOPE,
      NO_DB,
    );
    assert.deepEqual(result.rows, [[traces[0]]]);
    // Both traces have 5 output tokens: the 5 kept its value, and the LIMIT alone became 2.
    assert.deepEqual(read, [2]);
    assert.equal(result.truncated, false);
  });
});

describe("the language version of a saved query", () => {
  test("a version newer than this RQL is refused", async () => {
    use();
    await assert.rejects(
      runQuery(project, sql("select trace_id from traces", RQL_VERSION + 1), SCOPE, NO_DB),
      (error) =>
        error instanceof QueryError &&
        error.detail?.code === "rql_version" &&
        error.message.includes(`RQL version ${RQL_VERSION + 1}`),
    );
  });

  test("an older version that still compiles runs", async () => {
    use({ rqlVersion: 2 });
    const result = await runQuery(project, sql("select count(*) from traces", 1), SCOPE, NO_DB);
    assert.deepEqual(result.rows, [[2]]);
  });

  test("an older version that no longer compiles says so, with the error of the compiler", async () => {
    use({ rqlVersion: 2 });
    await assert.rejects(
      runQuery(project, sql("select * from spans", 1), SCOPE, NO_DB),
      (error) => {
        assert.ok(error instanceof QueryError);
        assert.equal(error.detail?.code, "unknown_table");
        assert.match(
          error.message,
          /written for RQL version 1, and no longer compiles in version 2/,
        );
        return true;
      },
    );
  });
});

/** Kind sql never reads the db of the metrics: RQL has its own read-only path. */
const NO_DB = {
  execute: async () => assert.fail("kind sql read the metrics db"),
} as unknown as MetricsDb;

function sql(text: string, rqlVersion = RQL_VERSION): Query & SqlQuery {
  return { version: 1, kind: "sql", text, rqlVersion };
}

function use(deps: { run?: Partial<RqlRunDeps>; rqlVersion?: number } = {}) {
  metricSeams.sql = sqlQueryRunner({
    rqlVersion: deps.rqlVersion,
    run: {
      executor: createPgRqlExecutor(pool),
      gate: createRqlGate(),
      observe: async () => {},
      ...deps.run,
    },
  });
}

/** As `use`, and the count of rows the database gave each run: the LIMIT the runner sent shows in it. */
function useCounted(): number[] {
  const read: number[] = [];
  const pg = createPgRqlExecutor(pool);
  use({
    run: {
      executor: {
        execute: async (run) => {
          const rows = await pg.execute(run);
          read.push(rows.length);
          return rows;
        },
      },
    },
  });
  return read;
}

async function seed(): Promise<void> {
  const client = await pool.connect();
  const q = (text: string, values: unknown[]) => client.query({ text, values });
  try {
    await q("insert into projects (id, organization_id, name, slug) values ($1, $2, $3, $3)", [
      project,
      randomUUID(),
      `p-${project.slice(0, 8)}`,
    ]);
    for (const [trace, hoursAgo] of [
      [traces[0], 1],
      [traces[1], 48],
    ] as const) {
      await q(
        `insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error,
           input_tokens, output_tokens, cost_usd, models, spans_max_received_at)
         values ($1, $2, $3, 100, false, 10, 5, 0.5, '{m}', now())`,
        [project, trace, new Date(NOW.getTime() - hoursAgo * HOUR).toISOString()],
      );
    }
  } finally {
    client.release();
  }
}

function hex(): string {
  return randomUUID().replaceAll("-", "").slice(2);
}
