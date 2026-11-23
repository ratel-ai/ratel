import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import { PROJECT_ID, setupDb } from "@/lib/readings/trace-signals/signals/integration-support";
import { WORKFLOW_NAME_SEPARATOR } from "@/lib/readings/trace-signals/workflows/name";
import { readIntents, readRunTasks, readTasks } from "@/lib/views/home/glance-queries";

type Client = Awaited<ReturnType<typeof setupDb>>["client"];

async function setup(): Promise<{ client: Client; db: BoundReadDb }> {
  const { client, db } = await setupDb();
  return { client, db: db as unknown as BoundReadDb };
}

function topic(id: string, turns: number, answered: number) {
  // The parts a tile never reads ride along, as a reading stores them.
  return {
    id,
    turns,
    answered,
    asks: turns,
    daily: [1, 2, 3],
    sentiment: null,
    tasks: [],
    untasked: 0,
    tools: [],
    selfCorrections: null,
    examples: ["e1"],
    askedAgain: 0,
    next: [],
  };
}

function insights(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    windowDays: 30,
    turns: 400,
    topics: [topic("t_schedule", 258, 250), topic("t_rental", 55, 0), topic("t_orphan", 20, 20)],
    tools: [],
    verdicts: { topic: 333, retry: 0, none: 67, no_ask: 0 },
    sources: { user: 0, prompt: 400, search: 0, none: 0 },
    ...overrides,
  };
}

async function seedIntents(client: Client, data: unknown) {
  await client.query(`insert into trace_topic_insights (project_id, data) values ($1, $2::jsonb)`, [
    PROJECT_ID,
    JSON.stringify(data),
  ]);
  await client.exec(`
    insert into trace_topics (project_id, topic_id, name, input_hash) values
      ('${PROJECT_ID}', 't_schedule', 'Schedule status', 'h1'),
      ('${PROJECT_ID}', 't_rental', 'Equipment rental', 'h2');
  `);
}

test("intents: no reading, then the reading's counts per intent and the stored names", async () => {
  const { client, db } = await setup();
  assert.equal(await readIntents(db, PROJECT_ID), null);
  await seedIntents(client, insights());
  const read = await readIntents(db, PROJECT_ID);
  assert.ok(read);
  assert.deepEqual(read.topics, [
    { id: "t_schedule", turns: 258, answered: 250 },
    { id: "t_rental", turns: 55, answered: 0 },
    { id: "t_orphan", turns: 20, answered: 20 },
  ]);
  assert.deepEqual(Object.fromEntries(read.names), {
    t_schedule: "Schedule status",
    t_rental: "Equipment rental",
  });
});

test("intents: a reading of another version, or missing its parts, is no reading (as on Intents)", async () => {
  for (const data of [
    insights({ version: 2 }),
    insights({ tools: null }),
    insights({ verdicts: undefined }),
    { version: 1 },
  ]) {
    const { client, db } = await setup();
    await seedIntents(client, data);
    assert.equal(await readIntents(db, PROJECT_ID), null, JSON.stringify(data).slice(0, 60));
  }
});

function task(id: string, order: string[], runs: number, finished: number) {
  return {
    id,
    fingerprint: id,
    coreTools: order,
    optionalTools: [],
    helperTools: [],
    entryTool: order[0],
    typicalOrder: order,
    orderStability: 1,
    runs,
    share: 0.5,
    health: {
      completion: finished / runs,
      completedRuns: finished,
      failedRuns: runs - finished,
      failingStep: null,
      medianMs: 900,
      p95Ms: 1200,
      slowestStep: null,
      retryRuns: 0,
      errorRuns: 0,
      meanToolCalls: 2,
      turnSourceMix: { declared: runs, inferred: 0, otlp: 0 },
    },
    examples: { failed: [], slow: [], recent: [] },
  };
}

async function seedTasks(client: Client) {
  const summary = {
    version: 1,
    coveredFrom: "2026-09-01",
    daily: [],
    flow: { nodes: [], edges: [] },
    workflows: {
      version: 1,
      turnsWithTools: 100,
      multiToolTurns: 100,
      singleStepTurns: 0,
      assignedTurns: 100,
      truncated: false,
      items: [
        task("task-a", ["find", "assign"], 60, 60),
        task("task-b", ["track", "notify"], 40, 30),
      ],
    },
  };
  await client.query(
    `insert into trace_signal_runs (project_id, trigger, status, window_days, window_start, window_end, turns_scanned, summary, finished_at)
     values ($1, 'manual', 'completed', 30, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', 100, $2::jsonb, '2026-10-01T00:00:00Z')`,
    [PROJECT_ID, JSON.stringify(summary)],
  );
  await client.query(
    `insert into trace_workflow_labels (project_id, workflow_id, input_hash, name, description, icon, label_source, model)
     values ($1, 'task-b', 'h', 'Track a delivery', 'Finds a delivery and tells the team.', 'truck', 'llm', 'm')`,
    [PROJECT_ID],
  );
}

test("tasks: no reading, then the list as Tasks builds it, with each task's own steps", async () => {
  const { client, db } = await setup();
  assert.equal(await readTasks(db, PROJECT_ID), null);
  await seedTasks(client);
  const read = await readTasks(db, PROJECT_ID);
  assert.ok(read);
  assert.equal(read.list.state, "ready");
  assert.deepEqual(
    read.list.rows.map((row) => [row.id, row.name, row.finishRate, row.color]),
    [
      // Unnamed by a model yet: its steps, in order.
      ["task-a", ["find", "assign"].join(WORKFLOW_NAME_SEPARATOR), 1, "chart-1"],
      ["task-b", "Track a delivery", 0.75, "chart-5"],
    ],
  );
  assert.equal(read.list.stats.finishRate, 0.9);
  assert.deepEqual(read.steps, [
    ["find", "assign"],
    ["track", "notify"],
  ]);
});

test("tasks: asks placed in a task that ran no tool count as unfinished, from insights of the version Tasks reads", async () => {
  const { client, db } = await setup();
  await seedTasks(client);
  const placed = { "task-b": { turns: 50, outside: 10, outsideWithErrors: 0 } };
  await client.query(
    `insert into trace_workflow_insights (project_id, data) values ($1, $2::jsonb)`,
    [
      PROJECT_ID,
      JSON.stringify({
        version: 3,
        asksSeen: 50,
        judged: 50,
        unclear: 0,
        placed,
        unserved: [{ label: "x", turns: 3, samples: ["book a crane"], turnIds: [] }],
      }),
    ],
  );
  const read = await readTasks(db, PROJECT_ID);
  assert.equal(read?.list.rows.find((row) => row.id === "task-b")?.finishRate, 30 / 50);
  await client.query(
    `update trace_workflow_insights set data = jsonb_set(data, '{version}', '2') where project_id = $1`,
    [PROJECT_ID],
  );
  const older = await readTasks(db, PROJECT_ID);
  assert.equal(
    older?.list.rows.find((row) => row.id === "task-b")?.finishRate,
    0.75,
    "older insights read as none",
  );
});

test("a run's task comes from its turn, for runs sent as OpenTelemetry", async () => {
  const { client, db } = await setup();
  const turn = (n: number, key: string, task: string | null, endedAt: string, status = "closed") =>
    client.query(
      `insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
       values ($1, $2, 's', $3, 'otlp', 'otlp', $4, $5, $5, $5, $6)`,
      [
        `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`,
        PROJECT_ID,
        key,
        status,
        endedAt,
        task,
      ],
    );
  await turn(1, "otlp:aaa", "task-a", "2026-10-15T10:00:02Z");
  await turn(2, "otlp:bbb", null, "2026-10-15T10:05:02Z");
  await turn(3, "otlp:ccc", "task-b", "2026-10-15T10:06:02Z", "open");
  await turn(4, "otlp:ddd", "task-b", "2026-09-01T10:00:00Z");
  const run = (traceId: string, at: string) => ({
    traceId,
    startedAt: new Date(at),
    endedAt: new Date(new Date(at).getTime() + 3_000),
  });
  const tasks = await readRunTasks(db, PROJECT_ID, [
    run("aaa", "2026-10-15T10:00:00Z"),
    run("bbb", "2026-10-15T10:05:00Z"),
    run("ccc", "2026-10-15T10:06:00Z"),
    run("eee", "2026-10-15T10:07:00Z"),
  ]);
  // No task, still open, or no turn at all: no pin.
  assert.deepEqual(Object.fromEntries(tasks), { aaa: "task-a" });
  assert.equal((await readRunTasks(db, PROJECT_ID, [])).size, 0);
});
