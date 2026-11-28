import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  flowQuery,
  funnelQuery,
  geographyQuery,
  type Query,
  type QueryFilters,
  stepFlowQuery,
} from "@/lib/contracts/query";
import type { FlowResult } from "@/lib/synthesis/metrics/flow";
import type { FunnelResult } from "@/lib/synthesis/metrics/funnel";
import type { GeographyResult } from "@/lib/synthesis/metrics/geography";
import { QueryError, runQuery } from "@/lib/synthesis/metrics/query";
import type { StepFlowResult } from "@/lib/synthesis/metrics/step-flow";
import { OTHER_PROJECT, PROJECT, traceDatabase } from "@/lib/synthesis/metrics/trace-fixture";
import "@/lib/views/scorers/metrics";

/**
 * The trace filter of the Flow, Step flow, Funnel and Map kinds (RTL-397): one filter, one SQL, so
 * a property, its absence, a user, a session and a task narrow each kind the same way.
 *
 * t1 plan pro    user u1  session s1  US  search > read     task checkout
 * t2 plan free   user u2  session s2  DE  read > answer     (task checkout in the other project)
 * t3 no plan     user u1  session s3  US  search > answer
 * o1 the other project: plan pro, FR, search > read
 */

const SCOPE = { since: new Date("2026-11-02T00:00:00Z"), until: new Date("2026-11-03T00:00:00Z") };

let database: Awaited<ReturnType<typeof traceDatabase>>;

before(async () => {
  database = await traceDatabase();
  const trace = (
    id: string,
    at: string,
    tools: string[],
    root: { plan?: string; user: string; session: string; country: string },
    projectId = PROJECT,
  ) => ({
    id,
    projectId,
    startedAt: `2026-11-02T${at}:00Z`,
    root: {
      endUserId: root.user,
      sessionId: root.session,
      properties: root.plan ? { plan: root.plan } : null,
      attributes: { "ratel.geo.country": root.country },
    },
    spans: tools.map((tool) => ({ tool })),
  });
  await database.seed([
    trace("t1", "09:00", ["search", "read"], {
      plan: "pro",
      user: "u1",
      session: "s1",
      country: "US",
    }),
    trace("t2", "10:00", ["read", "answer"], {
      plan: "free",
      user: "u2",
      session: "s2",
      country: "DE",
    }),
    trace("t3", "11:00", ["search", "answer"], { user: "u1", session: "s3", country: "US" }),
    trace(
      "o1",
      "12:00",
      ["search", "read"],
      { plan: "pro", user: "u1", session: "s1", country: "FR" },
      OTHER_PROJECT,
    ),
  ]);
  await database.client.exec(`
    insert into trace_property_keys (project_id, name, state, source, seen_count) values
      ('${PROJECT}', 'plan', 'indexed', 'user', 2),
      ('${PROJECT}', 'tenant', 'detected', 'user', 1),
      ('${OTHER_PROJECT}', 'plan', 'indexed', 'user', 1);
    insert into trace_turns (project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id) values
      ('${PROJECT}', 's1', 'otlp:t1', 'otlp', 'otlp', 'closed', '2026-11-02T09:00:00Z', '2026-11-02T09:01:00Z', '2026-11-02T09:01:00Z', 'checkout'),
      ('${OTHER_PROJECT}', 's2', 'otlp:t2', 'otlp', 'otlp', 'closed', '2026-11-02T10:00:00Z', '2026-11-02T10:01:00Z', '2026-11-02T10:01:00Z', 'checkout');
  `);
});

after(() => database.client.close());

const PRO = { properties: { plan: ["pro"] } };
const SEARCHED = { name: "Searched", condition: { type: "tool", name: "search" } } as const;
const NO_ERROR = { name: "No error", condition: { type: "no_error" } } as const;

test("flow: a property filter keeps only the traces with that value, of the project only", async () => {
  const result = await run<FlowResult>(flowQuery("tool", { filters: PRO }));
  assert.deepEqual(result.sample, { matched: 1, read: 1 });
  assert.deepEqual(edges(result), ["1 search>read 1"]);
  const other = await run<FlowResult>(flowQuery("tool", { filters: PRO }), OTHER_PROJECT);
  assert.deepEqual(other.sample, { matched: 1, read: 1 });
  const free = await run<FlowResult>(
    flowQuery("tool", { filters: { properties: { plan: ["free"] } } }),
    OTHER_PROJECT,
  );
  assert.deepEqual(free.sample, { matched: 0, read: 0 });
});

test("step flow: a property filter keeps only the traces with that value", async () => {
  const all = await run<StepFlowResult>(stepFlowQuery("tool", { start: "none" }));
  assert.equal(all.sample.matched, 3);
  const result = await run<StepFlowResult>(
    stepFlowQuery("tool", { start: "none", filters: { properties: { plan: ["free"] } } }),
  );
  assert.deepEqual(result.sample, { matched: 1, read: 1 });
  assert.equal(result.total, 1);
});

test("step flow and funnel: a property filter never keeps another project's traces", async () => {
  // o1 of the other project has plan pro too: each kind keeps only t1 for this project, only o1 for
  // the other.
  const stepFlow = (filters: QueryFilters) => stepFlowQuery("tool", { start: "none", filters });
  const funnel = (filters: QueryFilters) => funnelQuery([SEARCHED, NO_ERROR], { filters });
  for (const [project, matched] of [
    [PROJECT, 1],
    [OTHER_PROJECT, 1],
  ] as const) {
    const steps = await run<StepFlowResult>(stepFlow(PRO), project);
    assert.deepEqual(steps.sample, { matched, read: matched }, `step flow of ${project}`);
    const funneled = await run<FunnelResult>(funnel(PRO), project);
    assert.deepEqual(funneled.sample, { matched, read: matched }, `funnel of ${project}`);
  }
  const free = await run<StepFlowResult>(
    stepFlow({ properties: { plan: ["free"] } }),
    OTHER_PROJECT,
  );
  assert.deepEqual(free.sample, { matched: 0, read: 0 });
});

test("funnel: a property filter keeps only the traces with that value", async () => {
  const query = (filters: QueryFilters) => funnelQuery([SEARCHED, NO_ERROR], { filters });
  const all = await run<FunnelResult>(query({}));
  assert.deepEqual(counts(all), [2, 2]);
  const result = await run<FunnelResult>(query(PRO));
  assert.deepEqual(result.sample, { matched: 1, read: 1 });
  assert.deepEqual(counts(result), [1, 1]);
});

test("geography: a property filter keeps only the traces with that value, never another project's", async () => {
  const all = await run<GeographyResult>(geographyQuery("trace_count", "count"));
  assert.deepEqual(places(all), ["US 2", "DE 1"]);
  const result = await run<GeographyResult>(
    geographyQuery("trace_count", "count", { filters: PRO }),
  );
  assert.deepEqual(places(result), ["US 1"]);
  assert.deepEqual(result.located, { traces: 1, matched: 1 });
});

test("a property's absence keeps the traces without a value of it", async () => {
  const filters = { withoutProperties: ["plan"] };
  const flow = await run<FlowResult>(flowQuery("tool", { filters }));
  assert.deepEqual(edges(flow), ["1 search>answer 1"]);
  const map = await run<GeographyResult>(geographyQuery("trace_count", "count", { filters }));
  assert.deepEqual(places(map), ["US 1"]);
});

test("users, sessions and tasks narrow every kind, a task by the project's own runs", async () => {
  const matched = async (filters: QueryFilters) =>
    (await run<FlowResult>(flowQuery("tool", { filters }))).sample.matched;
  assert.equal(await matched({ users: ["u1"] }), 2);
  assert.equal(await matched({ sessions: ["s2", "s3"] }), 2);
  assert.equal(await matched({ tasks: ["checkout"] }), 1);
  const map = await run<GeographyResult>(
    geographyQuery("trace_count", "count", { filters: { tasks: ["checkout"] } }),
  );
  assert.deepEqual(places(map), ["US 1"]);
  const funnel = await run<FunnelResult>(
    funnelQuery([SEARCHED, NO_ERROR], { filters: { users: ["u2"] } }),
  );
  assert.deepEqual(funnel.sample, { matched: 1, read: 1 });
  assert.deepEqual(counts(funnel), [0, 0]);
});

test("the page filter's property narrows each kind as its own does", async () => {
  const result = await run<FlowResult>(flowQuery("tool"), PROJECT, { filter: PRO });
  assert.deepEqual(result.sample, { matched: 1, read: 1 });
});

test("a property that is not indexed is refused with its name, in the filter or its absence", async () => {
  const queries: Query[] = [
    flowQuery("tool", { filters: { properties: { tenant: ["a"] } } }),
    stepFlowQuery("tool", { filters: { withoutProperties: ["tenant"] } }),
    geographyQuery("trace_count", "count", { filters: { properties: { tenant: ["a"] } } }),
  ];
  for (const query of queries)
    await assert.rejects(run(query), (error: unknown) => {
      assert.ok(error instanceof QueryError);
      assert.equal(error.detail?.code, "property_not_indexed");
      assert.equal(error.detail?.property, "tenant");
      return true;
    });
});

function run<R>(query: Query, projectId = PROJECT, scope: object = {}): Promise<R> {
  return runQuery(projectId, query, { ...SCOPE, ...scope }, database.db) as Promise<R>;
}

function edges(result: FlowResult): string[] {
  return result.edges.map(
    ({ step, source, target, count }) => `${step} ${source}>${target} ${count}`,
  );
}

function counts(result: FunnelResult): number[] {
  return result.steps.map(({ count }) => count);
}

function places(result: GeographyResult): string[] {
  return result.places.map(({ code, value }) => `${code} ${value}`);
}
