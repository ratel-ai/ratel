import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type FunnelCondition, type FunnelQuery, funnelQuery } from "@/lib/contracts/query";
import { runQuery } from "@/lib/synthesis/metrics/query";
import { PROJECT, traceDatabase } from "@/lib/synthesis/metrics/trace-fixture";
import { runFunnel } from "./funnel";
import "./metrics";

/**
 * t1 search > read   prod     100 ms         passed, depth 5
 * t2 read > search   prod     900 ms, error  failed, depth 2
 * t3 search          staging  300 ms         passed
 * t4 the skill triage, then read  prod  300 ms
 */

const POLITE = "44444444-4444-4444-8444-444444444444";
const DEPTH = "55555555-5555-4555-8555-555555555555";
const SCOPE = { since: new Date("2026-11-02T00:00:00Z"), until: new Date("2026-11-03T00:00:00Z") };
const SEARCH: FunnelCondition = { type: "tool", name: "search" };
const READ: FunnelCondition = { type: "tool", name: "read" };
const OK: FunnelCondition = { type: "no_error" };

let database: Awaited<ReturnType<typeof traceDatabase>>;

before(async () => {
  database = await traceDatabase();
  const root = (environment: string, durationMs: number, plan = "free") => ({
    durationMs,
    attributes: { "deployment.environment.name": environment, "ratel.plan": plan },
  });
  await database.seed([
    {
      id: "t1",
      startedAt: "2026-11-02T09:00:00Z",
      root: root("prod", 100, "pro"),
      spans: [{ tool: "search" }, { tool: "read" }],
    },
    {
      id: "t2",
      startedAt: "2026-11-02T10:00:00Z",
      root: root("prod", 900),
      spans: [{ tool: "read" }, { tool: "search", statusCode: 2 }],
    },
    {
      id: "t3",
      startedAt: "2026-11-02T11:00:00Z",
      root: root("staging", 300),
      spans: [{ tool: "search" }],
    },
    {
      id: "t4",
      startedAt: "2026-11-02T12:00:00Z",
      root: root("prod", 300),
      spans: [{ skill: "triage" }, { tool: "read" }],
    },
  ]);
  await database.client.exec(`
    insert into trace_scorers (id, project_id, name, kind, config, created_by, updated_by) values
      ('${POLITE}', '${PROJECT}', 'Polite', 'judge', '{}', 'a', 'a'),
      ('${DEPTH}', '${PROJECT}', 'Depth', 'judge', '{}', 'a', 'a');
    insert into trace_scores (project_id, scorer_id, trace_id, value, passed, trace_started_at) values
      ('${PROJECT}', '${POLITE}', 't1', 1, true, '2026-11-02'),
      ('${PROJECT}', '${POLITE}', 't2', 0, false, '2026-11-02'),
      ('${PROJECT}', '${POLITE}', 't3', 1, true, '2026-11-02'),
      ('${PROJECT}', '${DEPTH}', 't1', 5, null, '2026-11-02'),
      ('${PROJECT}', '${DEPTH}', 't2', 2, null, '2026-11-02');
  `);
});

after(() => database.client.close());

test("the counts per step, in order and in any order", async () => {
  assert.deepEqual(await counts([SEARCH, READ]), [3, 1]);
  assert.deepEqual(await counts([SEARCH, READ], { order: "any_order" }), [3, 2]);
  assert.deepEqual(await counts([{ type: "skill", name: "triage" }, READ]), [1, 1]);
});

test("attributes go through the check engine, and the scorer results through their rows", async () => {
  const check = (path: string, op: "lt" | "eq", value: string | number): FunnelCondition => ({
    type: "attribute",
    path,
    op,
    value,
  });
  assert.deepEqual(await counts([OK, check("duration_ms", "lt", 300)]), [3, 1]);
  assert.deepEqual(await counts([SEARCH, check("attributes.ratel.plan", "eq", "pro")]), [3, 1]);
  // A trace without the value does not meet the step.
  assert.deepEqual(await counts([SEARCH, check("attributes.none", "eq", "x")]), [3, 0]);
  const scorer = { type: "scorer", scorer: { id: POLITE } } as const;
  assert.deepEqual(await counts([{ ...scorer, result: "passed" }, READ]), [2, 1]);
  assert.deepEqual(await counts([{ ...scorer, result: "failed" }, OK]), [1, 0]);
  const depth = { type: "scorer", scorer: { id: DEPTH }, atLeast: 4 } as const;
  assert.deepEqual(await counts([depth, OK]), [1, 1]);
});

test("the query's filter and the dashboard's must both match, and the cap is reported", async () => {
  assert.deepEqual(await counts([SEARCH, READ], { filters: { environments: ["prod"] } }), [2, 1]);
  const { sample } = await run([SEARCH, READ], {}, { filter: { environments: ["staging"] } });
  assert.deepEqual(sample, { matched: 1, read: 1 });
  const none = await run([SEARCH, READ], {}, { filter: { environments: ["none"] } });
  assert.deepEqual([none.sample.matched, none.steps.map(({ count }) => count)], [0, [0, 0]]);
  const capped = await runFunnel(PROJECT, query([OK, READ]), SCOPE, database.db, 2);
  assert.deepEqual([capped.sample, capped.steps[1].count], [{ matched: 4, read: 2 }, 1]);
});

function query(conditions: FunnelCondition[], rest: Partial<FunnelQuery> = {}) {
  return funnelQuery(
    conditions.map((condition, index) => ({ name: `Step ${index + 1}`, condition })),
    rest,
  );
}

function run(conditions: FunnelCondition[], rest: Partial<FunnelQuery> = {}, scope: object = {}) {
  return runQuery(PROJECT, query(conditions, rest), { ...SCOPE, ...scope }, database.db);
}

async function counts(conditions: FunnelCondition[], rest: Partial<FunnelQuery> = {}) {
  return (await run(conditions, rest)).steps.map(({ count }) => count);
}
