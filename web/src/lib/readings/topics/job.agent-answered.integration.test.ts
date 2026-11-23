import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AgentRun,
  ingestRuns,
  readIntents,
  setupAgentRunDb,
} from "@/lib/readings/topics/agent-run-test-support";
import { loadTopicReading } from "@/lib/readings/topics/queries";

/**
 * RC-813, flag `cloud-tool-run-insights`: an agent run (an OTel `invoke_agent`
 * root, RC-742) has one `agent` step and no tool call. "Answered" was read
 * from the tool calls alone, so every finished run counted as an unanswered
 * ask: Ratel's own prod project showed one intent of 10 completed runs with
 * `answered: 0` and `mostlyUnanswered: true`. With the flag on, a run whose
 * root ended without an error is answered, and one whose root failed is not.
 * With the flag off, the reading is as before.
 *
 * End to end on a real schema: OTLP ingest, the turn build, then the reading.
 */

/** Six finished runs and two failed ones (an `error.type`, and an error status alone) of one job kind. */
const RUNS: readonly AgentRun[] = [
  { agent: "label_workflows" },
  { agent: "label_workflows" },
  { agent: "label_workflows" },
  { agent: "label_workflows" },
  { agent: "label_workflows" },
  { agent: "label_workflows" },
  { agent: "label_workflows", errorType: "timeout" },
  { agent: "label_workflows", statusCode: 2 },
];

test("flag on: a finished agent run is an answered ask, a failed one is not", async () => {
  const db = await setupAgentRunDb();
  await ingestRuns(db, RUNS);
  const result = await readIntents(db, true);
  assert.equal(result.turns, 8);

  const insights = (await loadTopicReading(db.projectId, db.db))!.insights;
  assert.equal(insights.topics.length, 1);
  const topic = insights.topics[0]!;
  assert.equal(topic.turns, 8);
  assert.equal(topic.answered, 6, "the six runs whose root ended without an error");
  assert.deepEqual(topic.tools, [], "an agent run is not a tool call");
});

test("flag off: the same runs read as before, none answered", async () => {
  const db = await setupAgentRunDb();
  await ingestRuns(db, RUNS);
  const result = await readIntents(db, false);
  assert.equal(result.turns, 8);

  const insights = (await loadTopicReading(db.projectId, db.db))!.insights;
  assert.equal(insights.topics.length, 1);
  assert.equal(insights.topics[0]!.turns, 8);
  assert.equal(insights.topics[0]!.answered, 0);
});

test("flag on: an unplaced finished run is answered too", async () => {
  const db = await setupAgentRunDb();
  await ingestRuns(db, [
    { agent: "assign_topics" },
    { agent: "cluster_intents", errorType: "timeout" },
  ]);
  await readIntents(db, true);
  const insights = (await loadTopicReading(db.projectId, db.db))!.insights;
  assert.deepEqual(insights.unplaced, { turns: 2, answered: 1 });
});
