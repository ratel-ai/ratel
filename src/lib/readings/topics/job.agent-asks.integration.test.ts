import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { listClosedTurnsPage } from "@/lib/ledger/closed-turns";
import { type AssignTopicsDeps, assignProjectTopics } from "@/lib/readings/topics/job";
import {
  loadHelperTools,
  loadModelOnlyTraces,
  loadPreviousPlacements,
  loadRefusedTraces,
  loadSelfCorrectionKinds,
  loadStoredTopics,
  loadTopicReading,
  loadTurnTasks,
  readingStart,
  saveTopicReading,
} from "@/lib/readings/topics/queries";
import {
  type Db,
  PROJECT_ID,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import {
  loadCarriedVerdicts,
  loadVerdicts,
  saveVerdicts,
} from "@/lib/readings/trace-signals/workflows/decide-queries";
import {
  loadAskSourcesByTurn,
  loadWorkflowLabels,
} from "@/lib/readings/trace-signals/workflows/label-queries";
import { loadExampleAsks } from "@/lib/views/intents/topics-examples";

/**
 * RC-801, flag `cloud-tool-run-insights`: a backend job's ask is machine text,
 * `<job kind> for project <uuid>` plus the JSON payload (`jobAsk`). The uuid
 * differs per customer project, so the asks of one job kind are distinct asks
 * that share too few words to group, and none reaches the floor of a new
 * intent: "Ratel Cloud - prod" read 14 turns with asks, all unplaced. With
 * the flag on, such an ask reads as the job in words ("Cluster intents"), a
 * derived ask, so the runs of one job kind are one ask and make one intent,
 * and no project id shows in an intent or its examples.
 */

const NOW = new Date("2026-11-17T23:08:42Z");
const MINUTE = 60_000;

/** The runs "Ratel Cloud - prod" held on 2026-11-17 (list_traces): job kind, the project the job ran for, payload. */
const RUNS: readonly (readonly [kind: string, project: string, payload: string])[] = [
  ["cluster_intents", "9bedca48-de2b-4d50-9560-e3da19eec4c9", ""],
  ["label_workflows", "9dcf386e-4178-49bd-91ba-d6d76df2003f", "\n{}"],
  ["cluster_intents", "78215f1a-7e2e-476b-93bd-ea37c829cfd4", ""],
  ["cluster_intents", "bbc11075-c036-4ef8-a2cd-8e75f63d2f05", ""],
  ["cluster_intents", "c869e342-3ab9-4d80-9190-93a5e57bce13", ""],
  ["cluster_intents", "78215f1a-7e2e-476b-93bd-ea37c829cfd4", ""],
  ["cluster_intents", "9bedca48-de2b-4d50-9560-e3da19eec4c9", ""],
  ["cluster_intents", "bbc11075-c036-4ef8-a2cd-8e75f63d2f05", ""],
  ["cluster_intents", "78215f1a-7e2e-476b-93bd-ea37c829cfd4", ""],
  ["cluster_intents", "bbc11075-c036-4ef8-a2cd-8e75f63d2f05", ""],
  ["cluster_intents", "c869e342-3ab9-4d80-9190-93a5e57bce13", ""],
  ["cluster_intents", "78215f1a-7e2e-476b-93bd-ea37c829cfd4", ""],
  ["cluster_intents", "9bedca48-de2b-4d50-9560-e3da19eec4c9", ""],
  ["cluster_intents", "bbc11075-c036-4ef8-a2cd-8e75f63d2f05", ""],
];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** Each run as prod stored it before the flag: one model call that carries the root's ask, no `agent_run` row. */
async function seed(
  prompts: readonly string[] = RUNS.map(
    ([kind, project, payload]) => `${kind} for project ${project}${payload}`,
  ),
): Promise<{ client: PGlite; db: Db }> {
  const { client, db } = await setupDb();
  for (const [index, prompt] of prompts.entries()) {
    const at = new Date(NOW.getTime() - (300 - index * 15) * MINUTE).toISOString();
    await client.query(
      `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, client_event_id, trace_id, span_id, ingest_source, payload)
       values (gen_random_uuid(), $1, 'otlp_model_call', $2, $3, $3, $4, $5, 'span', 'otlp', $6::jsonb)`,
      [
        PROJECT_ID,
        `job-${index}`,
        at,
        `model-${index}`,
        index.toString(16).padStart(32, "0"),
        JSON.stringify({ prompt }),
      ],
    );
  }
  return { client, db };
}

function deps(db: Db, toolRuns: boolean): Partial<AssignTopicsDeps> {
  return {
    now: () => NOW,
    readingStart: (p, w, max) => readingStart(p, w, max, db),
    listPage: (p, range, _db, limit) => listClosedTurnsPage(p, range, db, limit),
    loadAsks: (p, ids) => loadAskSourcesByTurn(p, ids, db),
    loadModelOnlyTraces: (p, w, closed, max) => loadModelOnlyTraces(p, w, closed, max, db),
    loadRefusedTraces: (p, ids) => loadRefusedTraces(p, ids, db),
    idleCloseMs: 30 * MINUTE,
    hashSalt: "test-salt",
    loadTurnTasks: (p, ids) => loadTurnTasks(p, ids, db),
    loadHelperTools: (p) => loadHelperTools(p, db),
    loadSelfCorrections: (p, ids) => loadSelfCorrectionKinds(p, ids, db),
    loadTopics: (p) => loadStoredTopics(p, db),
    loadPreviousPlacements: (p, ids) => loadPreviousPlacements(p, ids, db),
    loadReading: (p) => loadTopicReading(p, db),
    loadVerdicts: (p, hash, hashes) => loadVerdicts(p, hash, hashes, db),
    saveVerdicts: (p, hash, model, rows) => saveVerdicts(p, hash, model, rows, db),
    saveReading: (p, reading) => saveTopicReading(p, reading, db),
    loadCarried: (p, hashes) => loadCarriedVerdicts(p, hashes, db),
    toolRunInsights: async () => toolRuns,
    loadTaskLabels: (p) => loadWorkflowLabels(p, db),
    judge: null,
    sentimentJudge: null,
    name: null,
    nameModel: "test-model",
    observability: { trackSystemEvent: async () => undefined },
  };
}

test("flag on: the runs of one job kind are one ask and make one intent, with no project id", async () => {
  const { db } = await seed();
  const result = await assignProjectTopics(PROJECT_ID, deps(db, true));
  assert.equal(result.turns, 14);

  const topics = await loadStoredTopics(PROJECT_ID, db);
  assert.deepEqual(
    topics.map((topic) => topic.name),
    ["Cluster intents"],
  );

  const reading = await loadTopicReading(PROJECT_ID, db);
  const insights = reading!.insights;
  assert.equal(
    insights.topics[0]!.turns,
    13,
    "the 13 cluster_intents runs, whatever project they ran for",
  );
  assert.equal(insights.unplaced.turns, 1, "one label_workflows run is under the floor of five");
  assert.equal(insights.sources.derived, 14);
  assert.equal(insights.sentimentMeasured, 0, "a job's ask is not a person's words");

  const examples = await loadExampleAsks(
    PROJECT_ID,
    insights.topics[0]!.examples,
    db,
    async () => true,
  );
  assert.ok(examples.length > 0);
  for (const example of examples) {
    assert.equal(example.text, "Cluster intents");
    assert.equal(example.source, "derived");
    assert.doesNotMatch(example.text, UUID);
  }
});

test("flag on: a job's old machine asks and its asks in words (RC-834) are one ask and make one intent", async () => {
  const fix = (n: number) => `${n}f3c0000-0000-4000-8000-000000000000`;
  const { db } = await seed([
    ...[1, 2, 3].map((n) => `draft_fix for project ${RUNS[0]![1]}\n{"fixId":"${fix(n)}"}`),
    ...[4, 5, 6].map((n) => `Draft a fix (fixId ${fix(n)})`),
  ]);
  await assignProjectTopics(PROJECT_ID, deps(db, true));

  const topics = await loadStoredTopics(PROJECT_ID, db);
  assert.equal(topics.length, 1, "one intent; its words-only name is the namer's, not this test's");
  const insights = (await loadTopicReading(PROJECT_ID, db))!.insights;
  assert.equal(insights.topics[0]!.turns, 6, "three runs before RC-834 and three after");
  assert.equal(insights.sources.derived, 6);
  const examples = await loadExampleAsks(
    PROJECT_ID,
    insights.topics[0]!.examples,
    db,
    async () => true,
  );
  for (const example of examples)
    assert.deepEqual([example.text, example.source], ["Draft fix", "derived"]);
});

test("flag off: the job asks are read as they are, all unplaced, as before", async () => {
  const { db } = await seed();
  const result = await assignProjectTopics(PROJECT_ID, deps(db, false));
  assert.equal(result.turns, 14);
  assert.equal(result.topics, 0);
  const reading = await loadTopicReading(PROJECT_ID, db);
  assert.equal(reading!.insights.unplaced.turns, 14);
  assert.equal(reading!.insights.sources.prompt, 14);
  assert.equal(reading!.insights.sources.derived ?? 0, 0);

  const ids = RUNS.slice(0, 2).map((_, index) => `trace:${index.toString(16).padStart(32, "0")}`);
  const examples = await loadExampleAsks(PROJECT_ID, ids, db, async () => false);
  assert.deepEqual(
    examples.map((example) => [example.text, example.source]),
    [
      ["cluster_intents for project 9bedca48-de2b-4d50-9560-e3da19eec4c9", "prompt"],
      ["label_workflows for project 9dcf386e-4178-49bd-91ba-d6d76df2003f {}", "prompt"],
    ],
  );
});
