import assert from "node:assert/strict";
import { test } from "node:test";
import { PROJECT_ID, setupDb } from "@/lib/readings/trace-signals/signals/integration-support";
import {
  loadLatestTasksRun,
  loadSegmentExamples,
  loadTaskCorrections,
  loadTaskSegmentSummaries,
  loadTaskTopics,
  taskOfAskTools,
} from "@/lib/views/tasks/queries";

const SINCE = new Date("2026-09-01T00:00:00Z");
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

type Client = Awaited<ReturnType<typeof setupDb>>["client"];

async function turns(client: Client, rows: { n: number; task: string | null; key?: string }[]) {
  for (const row of rows) {
    await client.query(
      `insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id, invoke_count, error_count)
       values ($1, $2, 'sess-1', $3, 'declared', 'runtime', 'closed', '2026-09-10T10:00:00Z', '2026-09-10T10:00:05Z', '2026-09-10T10:00:05Z', $4, 3, 1)`,
      [id(row.n), PROJECT_ID, row.key ?? `declared:t${row.n}`, row.task],
    );
  }
}

test("intents (stored as topics) per task go through each run's task; none assigned yet reads as not measured", async () => {
  const { client, db } = await setupDb();
  await turns(client, [
    { n: 1, task: "task-a" },
    { n: 2, task: "task-a" },
    { n: 3, task: "task-b" },
    { n: 4, task: null },
  ]);
  assert.equal(await loadTaskTopics(PROJECT_ID, SINCE, db), null);
  await client.exec(
    `insert into trace_topics (project_id, topic_id, name, input_hash) values ('${PROJECT_ID}', 'releases', 'Release notes', 'h')`,
  );
  for (const [n, topic, verdict] of [
    [1, "releases", "topic"],
    [2, "releases", "topic"],
    [3, "unnamed", "topic"],
    [4, "releases", "topic"],
  ] as const) {
    await client.query(
      `insert into trace_turn_topics (turn_id, project_id, topic_id, verdict, started_at) values ($1, $2, $3, $4, '2026-09-10T10:00:00Z')`,
      [id(n), PROJECT_ID, topic, verdict],
    );
  }
  const topics = await loadTaskTopics(PROJECT_ID, SINCE, db);
  assert.deepEqual(Object.fromEntries(topics!), {
    "task-a": [{ id: "releases", name: "Release notes", runs: 2 }],
    "task-b": [{ id: "unnamed", name: "Unnamed intent", runs: 1 }],
  });
});

test("self-corrections per task count through the run's task, by kind; none recorded reads as null", async () => {
  const { client, db } = await setupDb();
  await turns(client, [
    { n: 1, task: "task-a" },
    { n: 2, task: null },
  ]);
  assert.equal(await loadTaskCorrections(PROJECT_ID, SINCE, db), null);
  for (const [n, kind] of [
    [1, "retry_after_error"],
    [1, "retry_after_error"],
    [1, "phrase"],
    [2, "asked_again"],
  ] as const) {
    await client.query(
      `insert into trace_self_corrections (project_id, turn_id, kind, workflow_id, occurred_at) values ($1, $2, $3, null, '2026-09-10T10:00:01Z')`,
      [PROJECT_ID, id(n), kind],
    );
  }
  const recorded = await loadTaskCorrections(PROJECT_ID, SINCE, db);
  assert.deepEqual(
    Object.fromEntries(recorded!.byTask),
    { "task-a": { retry_after_error: 2, phrase: 1 } },
    "the row's own task column is not trusted",
  );
});

test("the latest completed run, read for its tasks and price only", async () => {
  const { client, db } = await setupDb();
  assert.equal(await loadLatestTasksRun(PROJECT_ID, db), null);
  await client.query(
    `insert into trace_signal_runs (project_id, trigger, status, window_days, window_start, window_end, turns_scanned, summary, finished_at)
     values ($1, 'manual', 'completed', 30, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', 80, $2::jsonb, '2026-10-01T00:00:00Z')`,
    [
      PROJECT_ID,
      JSON.stringify({
        version: 1,
        daily: [{ day: "2026-09-30" }],
        flow: { nodes: [] },
        workflows: { items: [{ id: "task-a" }] },
      }),
    ],
  );
  const run = await loadLatestTasksRun(PROJECT_ID, db);
  assert.equal(run?.turnsScanned, 80);
  assert.deepEqual(run?.workflows, { items: [{ id: "task-a" }] });
  assert.deepEqual(run?.daily, [{ day: "2026-09-30" }]);
});

test("an old Tool craft ask lands on the task its main tools run as", () => {
  const stored = {
    items: [
      { id: "task-release", coreTools: ["find", "assign", "notify"] },
      { id: "task-browse", coreTools: ["list", "open"] },
    ],
  };
  const ask = [
    { toolId: "find", share: 0.9 },
    { toolId: "assign", share: 0.85 },
    { toolId: "notify", share: 0.8 },
    { toolId: "open", share: 0.1 },
  ];
  assert.equal(taskOfAskTools(ask, stored), "task-release");
  assert.equal(taskOfAskTools([{ toolId: "search", share: 0.9 }], stored), null);
  assert.equal(taskOfAskTools(ask, null), null);
});

test("task counts and examples use segments and only the steps inside their bounds", async () => {
  const { client, db } = await setupDb();
  await turns(client, [{ n: 1, task: "task-a" }]);
  for (const [ordinal, kind, target] of [
    [1, "model_call", "engine"],
    [2, "code", "prepare_response"],
    [3, "model_call", "other"],
  ] as const) {
    await client.query(
      `insert into trace_turn_steps (turn_id,project_id,ordinal,kind,event_type,trace_event_id,occurred_at,received_at,target_id,outcome)
      values ($1,$2,$3,$4,'otlp_step',$5,'2026-09-10T10:00:00Z','2026-09-10T10:00:00Z',$6,'ok')`,
      [id(1), PROJECT_ID, ordinal, kind, id(100 + ordinal), target],
    );
  }
  for (const [n, task, start, end] of [
    [10, "task-a", 1, 2],
    [11, "task-b", 3, 3],
  ] as const) {
    await client.query(
      `insert into task_segments (id,project_id,session_id,workflow_id,start_turn_id,start_ordinal,end_turn_id,end_ordinal,started_at,ended_at,turn_ids,piece_count)
      values ($1,$2,'sess-1',$3,$4,$5,$4,$6,'2026-09-10T10:00:00Z','2026-09-10T10:00:05Z',array[$4::uuid],1)`,
      [id(n), PROJECT_ID, task, id(1), start, end],
    );
  }
  const summaries = await loadTaskSegmentSummaries(PROJECT_ID, SINCE, db);
  assert.equal(summaries.get("task-a")!.runs, 1);
  assert.equal(summaries.get("task-b")!.runs, 1);
  assert.equal(summaries.get("task-a")!.finishedRuns, 1);
  assert.equal(summaries.get("task-a")!.stepRuns?.get("model:engine"), 1);
  const examples = await loadSegmentExamples(PROJECT_ID, [id(10)], db);
  assert.deepEqual(
    examples.get(id(10))!.steps.map((s) => [s.kind, s.label]),
    [
      ["model_call", "Model call"],
      ["code", "Prepare response"],
    ],
  );
  assert.equal(examples.get(id(10))!.calls, 2);
  await client.close();
});
