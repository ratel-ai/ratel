import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type FlowQuery, flowQuery } from "@/lib/contracts/query";
import { type FlowEdge, runFlow } from "@/lib/synthesis/metrics/flow";
import { runQuery } from "@/lib/synthesis/metrics/query";
import { PROJECT, traceDatabase } from "@/lib/synthesis/metrics/trace-fixture";

/**
 * t1 search > read > answer     prod     agents planner, writer
 * t2 search > read > read       prod     agents planner, writer, planner
 * t3 read > answer              staging  the skill triage twice, then refund
 * t4 nothing                    prod
 * t5 search > answer, outside the window
 */

const SCOPE = { since: new Date("2026-11-02T00:00:00Z"), until: new Date("2026-11-03T00:00:00Z") };
const env = (name: string) => ({ attributes: { "deployment.environment.name": name } });

let database: Awaited<ReturnType<typeof traceDatabase>>;

before(async () => {
  database = await traceDatabase();
  await database.seed([
    {
      id: "t1",
      startedAt: "2026-11-02T09:00:00Z",
      root: { ...env("prod"), agentKey: "planner" },
      spans: [
        { tool: "search", agentKey: "planner" },
        // The client span inside the framework's one is the same call.
        { tool: "search", agentKey: "planner", parentSpanId: "t1-0", after: 1.5 },
        { tool: "read", agentKey: "writer" },
        { tool: "answer", agentKey: "writer" },
      ],
    },
    {
      id: "t2",
      startedAt: "2026-11-02T10:00:00Z",
      root: { ...env("prod"), agentKey: "planner" },
      // Stored out of order: the start decides.
      spans: [
        { tool: "read", agentKey: "planner", after: 3 },
        { tool: "read", agentKey: "writer", after: 2 },
        { tool: "search", agentKey: "planner", after: 1 },
      ],
    },
    {
      id: "t3",
      startedAt: "2026-11-02T11:00:00Z",
      root: env("staging"),
      spans: [
        { tool: "read", skill: "triage" },
        { tool: "answer", skill: "triage" },
      ],
    },
    { id: "t4", startedAt: "2026-11-02T12:00:00Z", root: env("prod") },
    {
      id: "t5",
      startedAt: "2026-11-03T00:00:00Z",
      spans: [{ tool: "search" }, { tool: "answer" }],
    },
  ]);
  await database.client.exec(`
    insert into trace_events (id, project_id, client_event_id, trace_id, type, schema_version, session_id, occurred_at, skill_id, payload)
    values (gen_random_uuid(), '${PROJECT}', 'e1', 't3', 'skill_invoke', 1, 's', '2026-11-02T11:00:09Z', 'refund', '{}');
  `);
});

after(() => database.client.close());

test("the moves of every trace are counted by step", async () => {
  const result = await run(flowQuery("tool"));
  assert.deepEqual(drawn(result.edges), [
    "1 search>read 2",
    "1 read>answer 1",
    "2 read>answer 1",
    "2 read>read 1",
  ]);
  assert.deepEqual(result.sample, { matched: 4, read: 4 });
  assert.equal(result.moreEdges, 0);
});

test("a start, an end, a step limit and an edge limit", async () => {
  const edges = async (rest: Partial<FlowQuery>) =>
    drawn((await run(flowQuery("tool", rest))).edges);
  assert.deepEqual(await edges({ start: "read" }), ["1 read>answer 2", "1 read>read 1"]);
  assert.deepEqual(await edges({ end: "answer" }), [
    "1 read>answer 1",
    "1 search>read 1",
    "2 read>answer 1",
  ]);
  assert.deepEqual(await edges({ start: "search", end: "answer" }), [
    "1 search>read 1",
    "2 read>answer 1",
  ]);
  assert.deepEqual(await edges({ steps: 2 }), ["1 search>read 2", "1 read>answer 1"]);
  // The end is past the step limit.
  assert.deepEqual(await edges({ start: "search", end: "answer", steps: 2 }), []);
  assert.deepEqual(await edges({ start: "nope" }), []);
  const { moreEdges, ...limited } = await run(flowQuery("tool", { edges: 1 }));
  assert.deepEqual(drawn(limited.edges), ["1 search>read 2"]);
  assert.equal(moreEdges, 3);
});

test("the query's filter and the dashboard's must both match", async () => {
  const staging = await run(flowQuery("tool", { filters: { environments: ["staging"] } }));
  assert.deepEqual(drawn(staging.edges), ["1 read>answer 1"]);
  const both = await run(flowQuery("tool", { filters: { environments: ["prod"] } }), {
    filter: { agents: ["writer"] },
  });
  assert.deepEqual(both.sample, { matched: 2, read: 2 });
  const none = await run(flowQuery("tool", { filters: { environments: ["prod"] } }), {
    filter: { environments: ["staging"] },
  });
  assert.deepEqual([none.edges, none.sample], [[], { matched: 0, read: 0 }]);
});

test("agents and skills: staying is no move, and a skill the SDK loaded counts", async () => {
  assert.deepEqual(drawn((await run(flowQuery("agent"))).edges), [
    "1 planner>writer 2",
    "2 writer>planner 1",
  ]);
  assert.deepEqual(drawn((await run(flowQuery("skill"))).edges), ["1 triage>refund 1"]);
});

test("the trace cap reads the newest traces and is reported", async () => {
  const { sample, edges } = await runFlow(PROJECT, flowQuery("tool"), SCOPE, database.db, 2);
  assert.deepEqual(sample, { matched: 4, read: 2 });
  assert.deepEqual(drawn(edges), ["1 read>answer 1"]);
});

function run(query: FlowQuery, scope: object = {}) {
  return runQuery(PROJECT, query, { ...SCOPE, ...scope }, database.db);
}

function drawn(edges: readonly FlowEdge[]) {
  return edges.map(({ step, source, target, count }) => `${step} ${source}>${target} ${count}`);
}
