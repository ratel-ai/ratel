import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import type { StoredTopicPattern } from "@/lib/readings/topics/types";
import {
  type Db,
  PROJECT_ID,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { loadIntentSteps, parseStepsStats } from "@/lib/views/intents/topics-steps-load";

/**
 * The panel's own read of "Step by step" against the real schema: one
 * intent's row picked out of the stored reading by a JSON path, the latest
 * signal run's tasks for the match, and every way it can come back empty.
 */

const PATTERN: StoredTopicPattern = {
  withCalls: 20,
  tools: [
    { id: "get_po", turns: 18 },
    { id: "track_delivery", turns: 16 },
  ],
  runs: 15,
  inOrder: 15,
  also: [],
  helpers: [{ id: "sync", turns: 19 }],
  firsts: [{ id: "get_po", turns: 17 }],
  comesBefore: [{ first: "get_po", tool: "track_delivery", turns: 16, together: 15 }],
  skills: { invoked: 0, offered: 0 },
};

async function seed(): Promise<{ client: PGlite; db: Db }> {
  const { client, db } = await setupDb();
  const topics = [
    { id: "t_delivery", turns: 20, tasks: [{ id: "wf_po", turns: 14 }], pattern: PATTERN },
    { id: "t_small", turns: 3, tasks: [] },
  ];
  await client.query(`insert into trace_topic_insights (project_id, data) values ($1, $2::jsonb)`, [
    PROJECT_ID,
    JSON.stringify({ version: 1, topics }),
  ]);
  await client.query(
    `insert into trace_signal_runs (project_id, trigger, status, window_days, window_start, window_end, summary)
     values ($1, 'manual', 'completed', 30, now() - interval '30 days', now(), $2::jsonb)`,
    [
      PROJECT_ID,
      JSON.stringify({
        workflows: {
          items: [{ id: "wf_po", runs: 40, typicalOrder: ["sync", "get_po", "track_delivery"] }],
        },
      }),
    ],
  );
  return { client, db };
}

test("one intent's steps, with the task its main path matches", async () => {
  const { client, db } = await seed();
  const read = await loadIntentSteps(PROJECT_ID, "t_delivery", { db });
  assert.equal(read.status, "ready");
  if (read.status !== "ready") return;
  assert.deepEqual(
    read.steps.sentence?.tools.map((tool) => tool.id),
    ["get_po", "track_delivery"],
  );
  assert.deepEqual(
    read.steps.helpers.map((tool) => tool.id),
    ["sync"],
  );
  assert.deepEqual(read.steps.task, {
    id: "wf_po",
    color: "chart-1",
    turns: 14,
    share: 0.7,
    exact: true,
  });
  assert.deepEqual(
    read.steps.picture.nodes.map((node) => node.key),
    ["intent", "intent>get_po", "intent>get_po>track_delivery"],
  );
  await client.close();
});

test("an intent without a pattern, an unknown intent, or another project read as none", async () => {
  const { client, db } = await seed();
  assert.deepEqual(await loadIntentSteps(PROJECT_ID, "t_small", { db }), { status: "none" });
  assert.deepEqual(await loadIntentSteps(PROJECT_ID, "t_missing", { db }), { status: "none" });
  assert.deepEqual(
    await loadIntentSteps("33333333-3333-4333-8333-333333333333", "t_delivery", { db }),
    { status: "none" },
  );
  await client.query(
    `update trace_topic_insights set data = jsonb_set(data, '{topics}', '{"broken": true}')`,
  );
  assert.deepEqual(
    await loadIntentSteps(PROJECT_ID, "t_delivery", { db }),
    { status: "none" },
    "a reading whose topics are not a list reads as none, not as a failure",
  );
  await client.query(`update trace_topic_insights set data = jsonb_set(data, '{version}', '2')`);
  assert.deepEqual(
    await loadIntentSteps(PROJECT_ID, "t_delivery", { db }),
    { status: "none" },
    "a reading of another version is not read",
  );
  await client.close();
});

test("a read that fails says so, for a Callout in place", async () => {
  const { client, db } = await seed();
  await client.exec("drop table trace_topic_insights cascade");
  assert.deepEqual(await loadIntentSteps(PROJECT_ID, "t_delivery", { db }), { status: "failed" });
  await client.close();
});

test("a stored row that does not parse reads as no row; a broken pattern as no pattern", () => {
  assert.equal(parseStepsStats(null), null);
  assert.equal(parseStepsStats({ id: 3, turns: 1 }), null);
  assert.deepEqual(
    parseStepsStats({
      id: "t",
      turns: 4,
      tasks: [{ id: "wf", turns: 2 }, { bad: true }],
      pattern: { tools: "x" },
    }),
    { id: "t", turns: 4, tasks: [{ id: "wf", turns: 2 }] },
  );
});
