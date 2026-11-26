import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { FEATURE_TRACER } from "@/lib/contracts/feature-spans";
import { compileRql, RQL_LIMITS, type RqlCompiled } from "../compile";
import type { RqlExecution, RqlExecutor } from "../ports/executor";
import { RqlSetupError } from "../ports/executor";
import { createRqlGate, type RqlRunDeps, type RqlRunObservation, runRql } from "../run";

const NOW = new Date("2026-11-25T12:00:00.000Z");
const PROJECT = "11111111-1111-4111-8111-111111111111";

function compiled(text: string): RqlCompiled {
  const result = compileRql(text, { now: NOW });
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}

function fakeExecutor(answer: (run: RqlExecution) => Promise<unknown[][]>): {
  executor: RqlExecutor;
  runs: RqlExecution[];
} {
  const runs: RqlExecution[] = [];
  return {
    runs,
    executor: {
      execute: (run) => {
        runs.push(run);
        return answer(run);
      },
    },
  };
}

function deps(executor: RqlExecutor, extra: Partial<RqlRunDeps> = {}) {
  const observed: RqlRunObservation[] = [];
  return {
    observed,
    deps: {
      executor,
      gate: createRqlGate(),
      observe: async (observation: RqlRunObservation) => {
        observed.push(observation);
      },
      ...extra,
    } satisfies Partial<RqlRunDeps>,
  };
}

test("the runner asks for one row more than the limit, with the project and the timeout", async () => {
  const query = compiled("select trace_id from traces limit 5");
  const { executor, runs } = fakeExecutor(async () => [["a"]]);
  await runRql(query, { projectId: PROJECT }, deps(executor).deps);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].projectId, PROJECT);
  assert.equal(runs[0].sql, query.sql);
  assert.deepEqual(
    runs[0].params,
    query.params.map((value, i) => (i === query.limitParam ? 6 : value)),
  );
  assert.equal(runs[0].timeoutMs, RQL_LIMITS.timeoutMs);
});

test("the result has the typed columns, the rows and no truncated mark under the cap", async () => {
  const query = compiled("select trace_id, count(*), sum(cost_usd) from traces group by trace_id");
  const { executor } = fakeExecutor(async () => [["t1", "3", "0.250000"]]);
  const result = await runRql(query, { projectId: PROJECT }, deps(executor).deps);
  assert.deepEqual(result, {
    ok: true,
    columns: [
      { name: "trace_id", type: "text" },
      { name: "count", type: "integer" },
      { name: "sum", type: "number" },
    ],
    rows: [["t1", 3, 0.25]],
    truncated: false,
  });
});

test("a result cut by the row cap is marked truncated and keeps limit rows", async () => {
  const query = compiled("select trace_id from traces limit 2");
  const { executor } = fakeExecutor(async () => [["a"], ["b"], ["c"]]);
  const result = await runRql(query, { projectId: PROJECT }, deps(executor).deps);
  assert.ok(result.ok);
  assert.deepEqual(result.rows, [["a"], ["b"]]);
  assert.equal(result.truncated, true);
});

test("a timestamp is an ISO string", async () => {
  const query = compiled("select started_at from traces");
  const { executor } = fakeExecutor(async () => [[new Date("2026-11-25T10:00:00.000Z")]]);
  const result = await runRql(query, { projectId: PROJECT }, deps(executor).deps);
  assert.ok(result.ok);
  assert.deepEqual(result.rows, [["2026-11-25T10:00:00.000Z"]]);
});

test("one query over the parallel cap of a project is refused, another project still runs", async () => {
  const query = compiled("select trace_id from traces");
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { executor, runs } = fakeExecutor(async () => {
    await held;
    return [];
  });
  const { deps: shared } = deps(executor);
  const running = Array.from({ length: RQL_LIMITS.parallelQueriesPerProject }, () =>
    runRql(query, { projectId: PROJECT }, shared),
  );
  const fifth = await runRql(query, { projectId: PROJECT }, shared);
  assert.equal(fifth.ok, false);
  assert.ok(!fifth.ok);
  assert.equal(fifth.error.code, "rql_busy");
  assert.match(fifth.error.message, new RegExp(`${RQL_LIMITS.parallelQueriesPerProject} queries`));
  assert.ok(fifth.error.fix.length > 0);
  assert.equal(runs.length, RQL_LIMITS.parallelQueriesPerProject, "the fifth never ran");

  const other = runRql(query, { projectId: "22222222-2222-4222-8222-222222222222" }, shared);
  release();
  await Promise.all([...running, other]);
  assert.equal(runs.length, RQL_LIMITS.parallelQueriesPerProject + 1);
  const after = await runRql(query, { projectId: PROJECT }, shared);
  assert.ok(after.ok, "a finished query frees its place");
});

test("a failed query frees its place in the gate", async () => {
  const query = compiled("select trace_id from traces");
  const { executor } = fakeExecutor(async () => {
    throw Object.assign(new Error("boom"), { code: "XX000" });
  });
  const { deps: shared } = deps(executor);
  for (let i = 0; i < RQL_LIMITS.parallelQueriesPerProject + 1; i++) {
    const result = await runRql(query, { projectId: PROJECT }, shared);
    assert.ok(!result.ok);
    assert.equal(result.error.code, "rql_query_failed");
  }
});

test("Postgres errors map to RQL errors with a code, a message and a fix", async () => {
  const query = compiled("select trace_id from traces");
  const cases: [unknown, string][] = [
    [
      Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }),
      "rql_timeout",
    ],
    [
      Object.assign(new Error("permission denied for table otel_spans"), { code: "42501" }),
      "rql_permission_denied",
    ],
    [
      Object.assign(new Error("cannot execute INSERT in a read-only transaction"), {
        code: "25006",
      }),
      "rql_read_only",
    ],
    [
      new RqlSetupError(
        Object.assign(new Error('role "ratel_rql" does not exist'), { code: "22023" }),
      ),
      "rql_unavailable",
    ],
    [Object.assign(new Error("division by zero"), { code: "22012" }), "rql_query_failed"],
  ];
  for (const [error, code] of cases) {
    const { executor } = fakeExecutor(async () => {
      throw error;
    });
    const result = await runRql(query, { projectId: PROJECT }, deps(executor).deps);
    assert.ok(!result.ok);
    assert.equal(result.error.code, code);
    assert.ok(result.error.message.length > 0 && result.error.fix.length > 0, code);
  }
  const timeout = await runRql(
    query,
    { projectId: PROJECT },
    deps(
      fakeExecutor(async () => {
        throw Object.assign(new Error("canceling statement due to statement timeout"), {
          code: "57014",
        });
      }).executor,
    ).deps,
  );
  assert.ok(
    !timeout.ok && timeout.error.message.includes(`${RQL_LIMITS.timeoutMs / 1000} seconds`),
  );
});

test("an error that is not a database error is thrown again", async () => {
  const query = compiled("select trace_id from traces");
  const { executor } = fakeExecutor(async () => {
    throw new TypeError("a bug");
  });
  await assert.rejects(runRql(query, { projectId: PROJECT }, deps(executor).deps), TypeError);
});

test("each run is observed with numbers and an outcome code, never the query or a literal", async () => {
  const query = compiled("select trace_id from traces where service_name = 'secret-svc' limit 1");
  const { executor } = fakeExecutor(async () => [["a"], ["b"]]);
  const { deps: run, observed } = deps(executor);
  await runRql(query, { projectId: PROJECT }, run);
  assert.equal(observed.length, 1);
  const [observation] = observed;
  assert.deepEqual(Object.keys(observation).sort(), [
    "columnCount",
    "durationMs",
    "outcome",
    "projectId",
    "rowCount",
    "table",
    "truncated",
  ]);
  assert.equal(observation.table, "traces");
  assert.equal(observation.columnCount, 1);
  assert.equal(observation.rowCount, 1);
  assert.equal(observation.outcome, "ok");
  assert.equal(observation.truncated, true);
  assert.ok(!JSON.stringify(observation).includes("secret-svc"));

  const { deps: busy, observed: busyObserved } = deps(executor, {
    gate: { enter: () => undefined, wait: async () => undefined },
  });
  await runRql(query, { projectId: PROJECT }, busy);
  assert.equal(busyObserved[0].outcome, "rql_busy");
});

test("each run is one feature.rql.run span with the same numbers and no query text", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const query = compiled("select trace_id from traces where service_name = 'secret-svc'");
  const { executor } = fakeExecutor(async () => [["a"]]);
  await runRql(
    query,
    { projectId: PROJECT },
    deps(executor, { tracer: provider.getTracer(FEATURE_TRACER) }).deps,
  );
  const [span] = exporter.getFinishedSpans();
  assert.equal(span?.name, "feature.rql.run");
  assert.equal(span?.attributes["rql.table"], "traces");
  assert.equal(span?.attributes["rql.column_count"], 1);
  assert.equal(span?.attributes["rql.row_count"], 1);
  assert.equal(span?.attributes["rql.outcome"], "ok");
  assert.equal(typeof span?.attributes["rql.duration_ms"], "number");
  assert.ok(!JSON.stringify(span?.attributes).includes("secret-svc"));
  assert.ok(!JSON.stringify(span?.attributes).includes("select"));
});
