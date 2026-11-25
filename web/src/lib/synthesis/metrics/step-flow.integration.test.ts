import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type StepFlowQuery, stepFlowQuery } from "@/lib/contracts/query";
import { runQuery } from "@/lib/synthesis/metrics/query";
import { runStepFlow, type StepFlowResult, stepPaths } from "@/lib/synthesis/metrics/step-flow";
import { foldStepFlow } from "@/lib/synthesis/metrics/step-flow-columns";
import { ORG, PROJECT, traceDatabase } from "@/lib/synthesis/metrics/trace-fixture";

/**
 * t1 search > read > answer > send > close   prod     agent planner   intent Refunds (OTLP turn)
 * t2 search > read > read                    prod     agent planner   intent Refunds (runtime turn)
 * t3 read > answer                           staging  agent writer    the skill triage, then refund
 * t4 nothing                                 prod     no agent        a turn that fits no intent
 * t5 search, outside the window
 */

const SCOPE = { since: new Date("2026-11-02T00:00:00Z"), until: new Date("2026-11-03T00:00:00Z") };
const env = (name: string) => ({ attributes: { "deployment.environment.name": name } });
const OTHER_PROJECT = "99999999-1111-4111-8111-111111111111";

let database: Awaited<ReturnType<typeof traceDatabase>>;

before(async () => {
  database = await traceDatabase();
  await database.seed([
    {
      id: "t1",
      startedAt: "2026-11-02T09:00:00Z",
      root: { ...env("prod"), agentKey: "planner" },
      spans: [
        { tool: "search", mcpServer: "crm" },
        { tool: "read", mcpServer: "crm" },
        // The server's side of the same call.
        { mcpServer: "crm", parentSpanId: "t1-1", after: 2.5 },
        { tool: "answer" },
        { tool: "send", mcpServer: "mail" },
        { tool: "close" },
        { spanClass: "llm_call", model: "big", after: 6 },
        // The provider's span inside the framework's one.
        { spanClass: "llm_call", model: "big", parentSpanId: "t1-6", after: 6.5 },
        { spanClass: "llm_call", model: "small", after: 7 },
      ],
    },
    {
      id: "t2",
      startedAt: "2026-11-02T10:00:00Z",
      root: { ...env("prod"), agentKey: "planner" },
      spans: [
        { tool: "read", agentKey: "writer", after: 3 },
        { tool: "read", after: 2 },
        { tool: "search", after: 1 },
      ],
    },
    {
      id: "t3",
      startedAt: "2026-11-02T11:00:00Z",
      root: { ...env("staging"), agentKey: "writer" },
      spans: [
        { tool: "read", skill: "triage" },
        { tool: "answer", skill: "triage" },
      ],
    },
    { id: "t4", startedAt: "2026-11-02T12:00:00Z", root: env("prod") },
    { id: "t5", startedAt: "2026-11-03T00:00:00Z", spans: [{ tool: "search" }] },
  ]);
  const turn = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  await database.client.exec(`
    insert into projects (id, organization_id, name, slug) values
      ('${OTHER_PROJECT}', '${ORG}', 'Other', 'other');
    insert into trace_events (id, project_id, client_event_id, trace_id, type, schema_version, session_id, occurred_at, skill_id, payload)
    values (gen_random_uuid(), '${PROJECT}', 'e1', 't3', 'skill_invoke', 1, 's', '2026-11-02T11:00:09Z', 'refund', '{}'),
      ('${turn(9)}', '${PROJECT}', 'e2', 't2', 'invoke_start', 1, 's', '2026-11-02T10:00:01Z', null, '{}');
    insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, started_at, ended_at, last_received_at) values
      ('${turn(1)}', '${PROJECT}', 's', 'otlp:t1', 'otlp', 'otlp', '2026-11-02T09:00:00Z', '2026-11-02T09:01:00Z', '2026-11-02T09:01:00Z'),
      ('${turn(2)}', '${PROJECT}', 's', 'declared:x', 'declared', 'runtime', '2026-11-02T10:00:00Z', '2026-11-02T10:01:00Z', '2026-11-02T10:01:00Z'),
      ('${turn(4)}', '${PROJECT}', 's', 'otlp:t4', 'otlp', 'otlp', '2026-11-02T12:00:00Z', '2026-11-02T12:01:00Z', '2026-11-02T12:01:00Z'),
      ('${turn(5)}', '${OTHER_PROJECT}', 's', 'otlp:t3', 'otlp', 'otlp', '2026-11-02T11:00:00Z', '2026-11-02T11:01:00Z', '2026-11-02T11:01:00Z');
    insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at) values
      ('${turn(2)}', '${PROJECT}', 1, 'invoke', 'invoke_start', '${turn(9)}', '2026-11-02T10:00:01Z', '2026-11-02T10:00:01Z');
    insert into trace_topics (project_id, topic_id, name, input_hash) values
      ('${PROJECT}', 'refunds', 'Refunds', 'h'), ('${OTHER_PROJECT}', 'secret', 'Secret', 'h');
    insert into trace_turn_topics (turn_id, project_id, topic_id, verdict, started_at) values
      ('${turn(1)}', '${PROJECT}', 'refunds', 'topic', '2026-11-02T09:00:00Z'),
      ('${turn(2)}', '${PROJECT}', 'refunds', 'topic', '2026-11-02T10:00:00Z'),
      ('${turn(4)}', '${PROJECT}', null, 'none', '2026-11-02T12:00:00Z'),
      ('${turn(5)}', '${OTHER_PROJECT}', 'secret', 'topic', '2026-11-02T11:00:00Z');
  `);
});

after(() => database.client.close());

test("tools: columns, counts, Ended, Later and the links between them", async () => {
  const result = await run(stepFlowQuery("tool", { steps: 2, start: "none" }));
  assert.equal(result.total, 4);
  assert.deepEqual(drawn(result), [
    "start 0 · 4: All traces 4",
    "step 1 · 3: search 2, read 1, ended 1",
    "step 2 · 3: read 2, answer 1",
    "later 3 · 2: later 2, ended 1",
  ]);
  assert.deepEqual(linked(result), [
    "s:All traces > c1:search 2",
    "s:All traces > c1:read 1",
    "s:All traces > e1 1",
    "c1:search > c2:read 2",
    "c1:read > c2:answer 1",
    "c2:read > later 2",
    "c2:answer > e3 1",
  ]);
  assert.deepEqual(result.sample, { matched: 4, read: 4 });
});

test("the last steps fold into Later, and a shorter flow has no empty column", async () => {
  const six = await run(stepFlowQuery("tool", { steps: 6, start: "none" }));
  assert.deepEqual(drawn(six).slice(3), [
    "step 3 · 2: answer 1, read 1, ended 1",
    "step 4 · 1: send 1, ended 1",
    "step 5 · 1: close 1",
    "later 6 · 0: ended 1",
  ]);
  const long = stepPaths(
    [{ traceId: "a", steps: Array.from({ length: 9 }, () => ({ kind: "tool", name: "x" })) }],
    new Map(),
    stepFlowQuery("tool"),
  );
  const { columns } = foldStepFlow(long.paths, { steps: 6, nodes: 7 });
  assert.deepEqual(
    columns.at(-1)?.nodes.map(({ kind, count }) => [kind, count]),
    [["later", 1]],
  );
});

test("the nodes over the limit fold into the bucket, and an expansion takes them out", async () => {
  const query = stepFlowQuery("tool", { steps: 1, nodes: 1, start: "agent" });
  const result = await run(query);
  assert.deepEqual(drawn(result), [
    "start 0 · 4: planner 2, rest(2) 2",
    "step 1 · 3: search 2, rest(1) 1, ended 1",
    "later 2 · 3: later 3",
  ]);
  assert.deepEqual(drawn(foldStepFlow(result, query, { 0: 3, 1: 3 })).slice(0, 2), [
    "start 0 · 4: planner 2, No agent 1, writer 1",
    "step 1 · 3: search 2, read 1, ended 1",
  ]);
});

test("skills: staying is one step, a skill the SDK loaded counts, and a filter narrows", async () => {
  const staging = { filters: { environments: ["staging"] } };
  assert.deepEqual(drawn(await run(stepFlowQuery("skill", staging))), [
    "start 0 · 1: writer 1",
    "step 1 · 1: triage 1",
    "step 2 · 1: refund 1",
    "later 3 · 0: ended 1",
  ]);
  const both = await run(stepFlowQuery("tool", staging), { filter: { environments: ["prod"] } });
  assert.deepEqual([both.total, both.sample], [0, { matched: 0, read: 0 }]);
  const prod = await run(stepFlowQuery("tool", { steps: 1 }), {
    filter: { environments: ["prod"] },
  });
  assert.deepEqual(drawn(prod)[1], "step 1 · 2: search 2, ended 1");
});

test("agents, MCP servers and models are steps too; a span inside another is the same call", async () => {
  const of = async (node: StepFlowQuery["node"]) =>
    drawn(await run(stepFlowQuery(node, { start: "none" }))).slice(1, -1);
  assert.deepEqual(await of("agent"), [
    "step 1 · 3: planner 2, writer 1, ended 1",
    "step 2 · 1: writer 1, ended 2",
  ]);
  assert.deepEqual(await of("mcp_server"), [
    "step 1 · 1: crm 1, ended 3",
    "step 2 · 1: crm 1",
    "step 3 · 1: mail 1",
  ]);
  assert.deepEqual(await of("model"), ["step 1 · 1: big 1, ended 3", "step 2 · 1: small 1"]);
});

test("the start is each trace's first agent, or the intent its turn was placed in", async () => {
  const start = async (by: StepFlowQuery["start"]) =>
    drawn(await run(stepFlowQuery("tool", { start: by })))[0];
  assert.equal(await start("agent"), "start 0 · 4: planner 2, No agent 1, writer 1");
  // t3 is placed in another project only, t4 fits no intent.
  assert.equal(await start("intent"), "start 0 · 4: No intent 2, Refunds 2");
});

test("what comes before: the steps back from a node's first visit, nearest first", async () => {
  const before = stepFlowQuery("tool", { mode: "before", target: "answer", start: "none" });
  const result = await run(before);
  assert.equal(result.total, 2);
  assert.deepEqual(drawn(result), [
    "start 0 · 2: All traces 2",
    "step 1 · 2: read 2",
    "step 2 · 1: search 1, ended 1",
    "later 3 · 0: ended 1",
  ]);
  assert.equal((await run({ ...before, target: "nope" })).total, 0);
});

test("the trace cap reads the newest traces and is reported", async () => {
  const result = await runStepFlow(PROJECT, stepFlowQuery("tool"), SCOPE, database.db, 2);
  assert.deepEqual(result.sample, { matched: 4, read: 2 });
  assert.equal(result.total, 2);
});

test("errors and slow steps are marked by the step's own outcome and time", () => {
  const trace = (index: number) => ({
    traceId: String(index),
    steps: [
      { kind: "tool" as const, name: "ok", failed: index === 0, durationMs: 10 },
      { kind: "tool" as const, name: "flaky", failed: index < 3, durationMs: 20 },
      { kind: "tool" as const, name: "slow", failed: false, durationMs: 60_000 },
    ],
  });
  const { marks } = stepPaths(
    Array.from({ length: 6 }, (_, index) => trace(index)),
    new Map(),
    stepFlowQuery("tool"),
  );
  assert.deepEqual(marks, [
    { step: 2, name: "flaky", errors: true, slow: false },
    { step: 3, name: "slow", errors: false, slow: true },
  ]);
});

function run(query: StepFlowQuery, scope: object = {}): Promise<StepFlowResult> {
  return runQuery(PROJECT, query, { ...SCOPE, ...scope }, database.db);
}

function drawn({ columns }: Pick<StepFlowResult, "columns">) {
  return columns.map(({ role, step, count, nodes }) => {
    const cards = nodes.map(
      (node) =>
        `${node.name || (node.folded ? `${node.kind}(${node.folded})` : node.kind)} ${node.count}`,
    );
    return `${role} ${step} · ${count}: ${cards.join(", ")}`;
  });
}

function linked({ links }: StepFlowResult) {
  return links.map(({ source, target, count }) => `${source} > ${target} ${count}`);
}
