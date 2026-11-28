import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SQL_TEXT, QUERY_VERSION, type SqlQuery } from "@/lib/contracts/query";
import { RQL_POOL_MAX } from "@/lib/platform/db/rql-pool";
import type { QueryScope } from "@/lib/synthesis/metrics/catalog";
import { QueryError, runQuery } from "@/lib/synthesis/metrics/query";
import { createPgRqlExecutor, FETCH_ROWS, type RqlPool } from "../adapters/pg-executor";
import {
  compileRql,
  describeRqlSchema,
  RQL_LIMITS,
  RQL_VERSION,
  type RqlCompiled,
} from "../compile";
import { RQL_TABLES } from "../domain/catalog";
import { RqlBusyError, type RqlExecution, type RqlExecutor } from "../ports/executor";
import { sqlQueryRunner } from "../query";
import { createRqlGate, RQL_PLACES_PER_PROJECT, runRql } from "../run";

/**
 * What one query can cost: its output columns, its cells, its bytes, the time of its compile and
 * the connections it holds. Each test names the bound of `RQL_LIMITS` it shows.
 */

const NOW = new Date("2026-11-25T12:00:00.000Z");
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const SCOPE = { since: new Date(NOW.getTime() - 3_600_000), until: NOW };

function compiled(text: string): RqlCompiled {
  const result = compileRql(text, { now: NOW });
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}

function refused(text: string) {
  const result = compileRql(text, { now: NOW });
  assert.ok(!result.ok, `${text.slice(0, 80)} compiled`);
  return result.error;
}

/** Compiles `text` and gives the error and the time the compile took. */
function timedRefusal(text: string) {
  const started = performance.now();
  const error = refused(text);
  return { error, ms: performance.now() - started };
}

function executor(answer: (run: RqlExecution) => Promise<unknown[][]>) {
  const runs: RqlExecution[] = [];
  const value: RqlExecutor = {
    execute: (run) => {
      runs.push(run);
      return answer(run);
    },
  };
  return { executor: value, runs };
}

const quiet = { observe: async () => {} };
/** Kind sql reads through the RQL pool: the metrics db is only the argument of the contract. */
const NO_DB = {} as never;

// Major 1: the memory of one result.

test("a select of more than maxSelectItems columns is refused at compile", () => {
  const columns = (n: number) => Array.from({ length: n }, () => "trace_id").join(", ");
  assert.ok(
    compileRql(`select ${columns(RQL_LIMITS.maxSelectItems)} from traces`, { now: NOW }).ok,
  );
  const error = refused(`select ${columns(RQL_LIMITS.maxSelectItems + 1)} from traces`);
  assert.equal(error.code, "too_many_columns");
  assert.match(error.message, new RegExp(`at most ${RQL_LIMITS.maxSelectItems}`));
});

test("each column of an expanded * counts toward maxSelectItems", () => {
  const events = RQL_TABLES.find(({ name }) => name === "events");
  assert.ok(events);
  const stars = Math.floor(RQL_LIMITS.maxSelectItems / events.columns.length) + 1;
  const error = refused(
    `select ${Array.from({ length: stars }, () => "*").join(", ")} from events`,
  );
  assert.equal(error.code, "too_many_columns");
  assert.match(error.message, /each column of \* counts/);
});

test("a cell over maxCellChars is cut, and the result is marked truncated", async () => {
  const long = "x".repeat(RQL_LIMITS.maxCellChars + 500);
  const attributes = { key: "y".repeat(RQL_LIMITS.maxCellChars) };
  const { executor: fake } = executor(async () => [[long, attributes, "short"]]);
  const result = await runRql(
    compiled("select name, attributes, model from events"),
    { projectId: A },
    { ...quiet, executor: fake, gate: createRqlGate() },
  );
  assert.ok(result.ok);
  const [name, attrs, model] = result.rows[0] as [string, string, string];
  assert.equal(name, long.slice(0, RQL_LIMITS.maxCellChars));
  assert.equal(attrs, JSON.stringify(attributes).slice(0, RQL_LIMITS.maxCellChars));
  assert.equal(model, "short");
  assert.equal(result.truncated, true);
});

test("the rows stop before maxResultBytes, and the result is marked truncated", async () => {
  const cell = "z".repeat(RQL_LIMITS.maxCellChars);
  const { executor: fake, runs } = executor(async () =>
    Array.from({ length: RQL_LIMITS.maxLimit }, () => [cell]),
  );
  const result = await runRql(
    compiled(`select name from events limit ${RQL_LIMITS.maxLimit}`),
    { projectId: A },
    { ...quiet, executor: fake, gate: createRqlGate() },
  );
  assert.ok(result.ok);
  assert.equal(runs[0].maxBytes, RQL_LIMITS.maxResultBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(result.rows)) <= RQL_LIMITS.maxResultBytes);
  assert.ok(result.rows.length > 0 && result.rows.length < RQL_LIMITS.maxLimit);
  assert.equal(result.truncated, true);
});

test("the pg executor stops reading the cursor once the rows pass maxBytes", async () => {
  const fetches: string[] = [];
  const cell = "w".repeat(RQL_LIMITS.maxCellChars * 10);
  const pool: RqlPool = {
    async connect() {
      return {
        query: async ({ text }: { text: string }) => {
          if (text.startsWith("fetch")) {
            fetches.push(text);
            return { rows: Array.from({ length: FETCH_ROWS }, () => [cell]) };
          }
          return { rows: [] };
        },
        release: () => {},
      };
    },
  };
  const rows = await createPgRqlExecutor(pool).execute({
    projectId: A,
    sql: "select 1",
    params: [],
    timeoutMs: 1000,
    maxBytes: RQL_LIMITS.maxResultBytes,
  });
  // A cursor that never ends: the executor stops on the bytes, at the cut size of each row.
  const rowsAtCap = Math.ceil(RQL_LIMITS.maxResultBytes / (RQL_LIMITS.maxCellChars + 5));
  assert.ok(rows.length >= rowsAtCap && rows.length <= rowsAtCap + 1, `${rows.length} rows`);
  assert.ok(fetches.length <= Math.ceil(rowsAtCap / FETCH_ROWS) + 1, `${fetches.length} fetches`);
});

// Major 2: the time of the compile.

test("a text over maxTextChars is refused before the parse, and the contract has the same cap", () => {
  assert.equal(MAX_SQL_TEXT, RQL_LIMITS.maxTextChars);
  const text = `select trace_id from traces where trace_id = '${"a".repeat(RQL_LIMITS.maxTextChars)}'`;
  const { error, ms } = timedRefusal(text);
  assert.equal(error.code, "query_too_long");
  assert.match(error.message, new RegExp(`at most ${RQL_LIMITS.maxTextChars}`));
  assert.ok(ms < 50, `${ms} ms`);
});

test("a run of statement separators is refused before the parse, in a short time", () => {
  const prefix = "select 1 from traces";
  const { error, ms } = timedRefusal(prefix + ";".repeat(RQL_LIMITS.maxTextChars - prefix.length));
  assert.equal(error.code, "multiple_statements");
  assert.ok(ms < 50, `${ms} ms`);
  assert.equal(refused("select 1 from traces; select 2 from traces").code, "multiple_statements");
  // One closing separator is still one statement.
  assert.ok(compileRql("select trace_id from traces; -- end", { now: NOW }).ok);
});

test("a list of more than maxListItems items is refused before the parse, in a short time", () => {
  const prefix = "select trace_id from traces group by 1";
  const many = prefix + ",1".repeat((RQL_LIMITS.maxTextChars - prefix.length) / 2);
  const { error, ms } = timedRefusal(many);
  assert.equal(error.code, "too_many_items");
  assert.ok(ms < 50, `${ms} ms`);
  const items = (n: number) => Array.from({ length: n }, (_, i) => `'v${i}'`).join(",");
  assert.ok(
    compileRql(
      `select count(*) from traces where trace_id in (${items(RQL_LIMITS.maxListItems)})`,
      {
        now: NOW,
      },
    ).ok,
  );
  assert.equal(
    refused(`select count(*) from traces where trace_id in (${items(RQL_LIMITS.maxListItems + 1)})`)
      .code,
    "too_many_items",
  );
  // A comma inside a text is not an item.
  assert.ok(
    compileRql(`select count(*) from traces where trace_id = '${",".repeat(500)}'`, { now: NOW })
      .ok,
  );
});

test("a stored sql text over the cap gives a clear error at run, not a crash", async () => {
  const query: SqlQuery = {
    version: QUERY_VERSION,
    kind: "sql",
    text: `select trace_id from traces where trace_id = '${"a".repeat(RQL_LIMITS.maxTextChars)}'`,
    rqlVersion: RQL_VERSION,
  };
  await assert.rejects(
    runQuery(A, query, SCOPE, NO_DB),
    (error: unknown) =>
      error instanceof QueryError && /at most 4,000 characters/.test(error.message),
  );
});

// Major 3: the connections.

/**
 * The RQL pool of this server as a fake: `RQL_POOL_MAX` connections for every project, a run past
 * them is `RqlBusyError` (the connect timeout). A console or `run_rql` run of project A holds its
 * connection until `release`; any other run (project B, an alert rule) answers at once.
 */
function poolOfEight() {
  let open = 0;
  let most = 0;
  const runs: RqlExecution[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const value: RqlExecutor = {
    async execute(run) {
      if (open >= RQL_POOL_MAX)
        throw new RqlBusyError(new Error("timeout exceeded when trying to connect"));
      open += 1;
      most = Math.max(most, open);
      runs.push(run);
      try {
        if (run.projectId === A && run.timeoutMs !== RQL_LIMITS.alertTimeoutMs) await held;
        return [["t"]];
      } finally {
        open -= 1;
      }
    },
  };
  return { executor: value, runs, release: () => release(), open: () => open, most: () => most };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * Project A fills every place of its console and `run_rql` paths, through the gates of this
 * process, and one more query of each path waits. What is left of the pool is what B and the
 * alert rules get.
 */
async function projectAHoldsItsPlaces() {
  const pool = poolOfEight();
  const runner = sqlQueryRunner({ run: { ...quiet, executor: pool.executor } });
  const read = (projectId: string, scope: QueryScope, text = "select trace_id from traces") =>
    runner(
      projectId,
      { version: QUERY_VERSION, kind: "sql", text, rqlVersion: RQL_VERSION },
      scope,
      NO_DB,
    );
  const agent = { ...SCOPE, purpose: "agent" as const };
  const held = [
    ...Array.from({ length: RQL_LIMITS.parallelConsoleQueriesPerProject + 1 }, () =>
      read(A, SCOPE),
    ),
    ...Array.from({ length: RQL_LIMITS.parallelQueriesPerProject + 1 }, () => read(A, agent)),
  ];
  await settle();
  const own = RQL_LIMITS.parallelConsoleQueriesPerProject + RQL_LIMITS.parallelQueriesPerProject;
  assert.equal(pool.open(), own, "A holds 4 console and 2 run_rql connections, no more");
  const done = async () => {
    pool.release();
    await Promise.all(held);
  };
  return { pool, read, done };
}

test("no project can hold every RQL connection: the places of its paths are fewer than the pool", () => {
  assert.equal(RQL_POOL_MAX, 8);
  assert.equal(RQL_PLACES_PER_PROJECT, 7);
  assert.equal(
    RQL_PLACES_PER_PROJECT,
    RQL_LIMITS.parallelConsoleQueriesPerProject +
      RQL_LIMITS.parallelQueriesPerProject +
      RQL_LIMITS.parallelAlertQueriesPerProject,
  );
  assert.ok(RQL_POOL_MAX > RQL_PLACES_PER_PROJECT, "the pool outlasts one project");
});

test("project B is answered while project A holds its 4 console and 2 run_rql places, on a pool of 8", async () => {
  const { pool, read, done } = await projectAHoldsItsPlaces();
  const answer = await read(B, SCOPE);
  assert.equal(answer.kind, "sql");
  assert.deepEqual(answer.kind === "sql" && answer.rows, [["t"]]);
  const agentAnswer = await read(B, { ...SCOPE, purpose: "agent" });
  assert.equal(agentAnswer.kind, "sql");
  assert.equal(pool.runs.filter(({ projectId }) => projectId === B).length, 2);
  await done();
  assert.ok(pool.most() < RQL_POOL_MAX, "the pool never ran out");
});

test("an alert rule of project A still evaluates while A holds its console and run_rql places", async () => {
  const { pool, read, done } = await projectAHoldsItsPlaces();
  // A's rule and B's widget at the same time: they take the last two connections of the pool.
  const [rule, other] = await Promise.all([
    read(A, { ...SCOPE, purpose: "alert" }, "select count(*) from traces"),
    read(B, SCOPE),
  ]);
  assert.equal(rule.kind, "sql");
  assert.equal(other.kind, "sql");
  assert.ok(
    pool.runs.some(
      ({ projectId, timeoutMs }) => projectId === A && timeoutMs === RQL_LIMITS.alertTimeoutMs,
    ),
    "the rule ran with the alert timeout",
  );
  assert.equal(pool.open(), 6, "A's console and run_rql places are still held");
  await done();
  assert.ok(pool.most() <= RQL_POOL_MAX, "the pool never ran out");
});

test("a connect timeout of the pool gives rql_busy, not the setup error", async () => {
  const pool = (error: Error): RqlPool => ({
    connect: () => Promise.reject(error),
  });
  const run = (error: Error) =>
    runRql(
      compiled("select trace_id from traces"),
      { projectId: A },
      { ...quiet, executor: createPgRqlExecutor(pool(error)), gate: createRqlGate() },
    );
  const busy = await run(new Error("timeout exceeded when trying to connect"));
  assert.ok(!busy.ok);
  assert.equal(busy.error.code, "rql_busy");
  assert.doesNotMatch(busy.error.message, /not set up/);
  const refusedConnection = await run(new Error("connect ECONNREFUSED 127.0.0.1:5432"));
  assert.ok(!refusedConnection.ok);
  assert.equal(refusedConnection.error.code, "rql_unavailable");
});

test("describe_rql_schema gives the new bounds in its limits and its rules", () => {
  const { limits, rules } = describeRqlSchema();
  assert.equal(limits.maxTextChars, 4000);
  assert.equal(limits.maxSelectItems, 50);
  assert.equal(limits.maxCellChars, 2000);
  assert.equal(limits.maxResultBytes, 1_000_000);
  assert.equal(limits.parallelQueriesPerProject, 2);
  assert.equal(limits.parallelConsoleQueriesPerProject, 4);
  const text = rules.join("\n");
  for (const value of ["4000 characters", "50 output columns", "2000 characters", "1 MB"]) {
    assert.ok(text.includes(value), value);
  }
});

test("rows the executor stopped on its byte cap mark the result truncated, though they shrink once typed", async () => {
  // A text cell and 49 integers as pg gives them (strings): typed, each integer loses its quotes.
  const row = ["t".repeat(1200), ...Array.from({ length: 49 }, () => "123456789012345")];
  const typedBytes = Buffer.byteLength(JSON.stringify([row[0], ...row.slice(1).map(Number)]));
  const rawBytes = Buffer.byteLength(JSON.stringify(row));
  // Enough rows to pass the cap as read, not as typed: what the executor gives when it stops.
  const count = Math.floor(RQL_LIMITS.maxResultBytes / typedBytes) - 1;
  assert.ok(count * rawBytes > RQL_LIMITS.maxResultBytes);
  const columns = ["name", ...Array.from({ length: 49 }, () => "input_tokens")].join(", ");
  const { executor: fake } = executor(async () => Array.from({ length: count }, () => [...row]));
  const result = await runRql(
    compiled(`select ${columns} from events limit ${RQL_LIMITS.maxLimit}`),
    { projectId: A },
    { ...quiet, executor: fake, gate: createRqlGate() },
  );
  assert.ok(result.ok);
  assert.equal(result.rows.length, count);
  assert.equal(result.truncated, true);
});

test("the timeout bounds the whole read of the cursor, not each fetch", async () => {
  const settings: string[] = [];
  const pool: RqlPool = {
    async connect() {
      return {
        query: async ({ text, values }: { text: string; values?: unknown[] }) => {
          if (text.includes("statement_timeout")) settings.push(String(values?.at(-1)));
          if (text.startsWith("fetch")) {
            await new Promise((resolve) => setTimeout(resolve, 40));
            return { rows: Array.from({ length: FETCH_ROWS }, () => ["x"]) };
          }
          return { rows: [] };
        },
        release: () => {},
      };
    },
  };
  const started = Date.now();
  await assert.rejects(
    createPgRqlExecutor(pool).execute({
      projectId: A,
      sql: "select 1",
      params: [],
      timeoutMs: 100,
      maxBytes: RQL_LIMITS.maxResultBytes,
    }),
    (error: { code?: string }) => error.code === "57014",
  );
  // Before the fix, the fetches went on until the byte cap: about a minute here.
  assert.ok(Date.now() - started < 2000, "stopped near the timeout");
  // Each fetch gets the time left, never the whole timeout again.
  const left = settings.slice(1).map(Number);
  assert.ok(left.length > 1 && left.every((ms) => ms <= 100), settings.join(","));
  assert.ok((left.at(-1) ?? 100) < 100, settings.join(","));
});
