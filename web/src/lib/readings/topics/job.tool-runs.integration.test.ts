import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { listClosedTurnsPage } from "@/lib/ledger/closed-turns";
import { TurnFixture } from "@/lib/ledger/test-support";
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
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { hashText, normalizeAsk } from "@/lib/readings/trace-signals/workflows/decide";
import {
  loadCarriedVerdicts,
  loadVerdicts,
  saveVerdicts,
} from "@/lib/readings/trace-signals/workflows/decide-queries";
import {
  loadAskSourcesByTurn,
  loadWorkflowLabels,
} from "@/lib/readings/trace-signals/workflows/label-queries";

/**
 * RC-743, flag `cloud-tool-run-insights`: a tool-only run (an MCP server's
 * calls: no user message, no prompt, no search) has no ask, so a reading put
 * every such turn in `no_ask` and made no intent. With the flag on, such a
 * turn reads a derived ask: its task's name when the task is labelled, else
 * its tool path. The ask is stored with the source `derived`, never read as
 * the user's words. With the flag off, the reading is as before.
 */

const START = Date.parse("2026-09-01T09:00:00Z");
const NOW = new Date("2026-09-10T12:00:00Z");
const MINUTE = 60_000;

/** Six runs of each tool path: a new intent needs five turns (`NEW_TOPIC_MIN_TURNS`). */
async function seed(): Promise<{ client: PGlite; db: Db; labelled: string }> {
  const { client, db } = await setupDb();
  const fixtures: TurnFixture[] = [];
  for (let i = 0; i < 6; i += 1) {
    fixtures.push(
      new TurnFixture({ session: `d${i}`, turnId: `define-${i}`, start: START + i * 60 * MINUTE })
        .invoke("mcp__beluga_board__task_define")
        .invoke("mcp__beluga_board__task_update")
        .invoke("mcp__beluga_board__task_define"),
    );
    fixtures.push(
      new TurnFixture({
        session: `p${i}`,
        turnId: `proof-${i}`,
        start: START + i * 60 * MINUTE + 10 * MINUTE,
      })
        .invoke("mcp__beluga_board__task_get")
        .invoke("mcp__beluga_board__task_attach_proof"),
    );
  }
  fixtures.push(
    new TurnFixture({ session: "w0", turnId: "labelled-0", start: START + 12 * 60 * MINUTE })
      .invoke("list_traces")
      .invoke("get_trace"),
  );
  await seedLedger(client, db, fixtures);
  const [labelled] = (
    await client.query<{ id: string }>(
      `select id from trace_turns where turn_key = 'declared:labelled-0'`,
    )
  ).rows;
  await client.query(`update trace_turns set workflow_id = 'wf_review' where id = $1`, [
    labelled!.id,
  ]);
  await client.query(
    `insert into trace_workflow_labels (project_id, workflow_id, input_hash, name, description) values ($1, 'wf_review', 'h', 'Review failing traces', '')`,
    [PROJECT_ID],
  );
  return { client, db, labelled: labelled!.id };
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

test("flag on: tool-only runs read a derived ask (task name, else tool path) and make intents", async () => {
  const { client, db, labelled } = await seed();
  const result = await assignProjectTopics(PROJECT_ID, deps(db, true));
  assert.equal(result.turns, 13);
  assert.ok(result.topics >= 2, `expected intents, got ${result.topics}`);

  const reading = await loadTopicReading(PROJECT_ID, db);
  assert.equal(reading?.insights.verdicts.no_ask, 0);
  assert.equal(reading?.insights.sources.derived, 13);
  assert.equal(reading?.insights.sentimentMeasured, 0, "a derived ask is not the user's words");

  const names = (await loadStoredTopics(PROJECT_ID, db)).map((topic) => topic.name.toLowerCase());
  assert.ok(
    names.some((name) => name.includes("task define")),
    `tool path names an intent: ${names.join(" | ")}`,
  );
  assert.ok(
    names.some((name) => name.includes("attach proof")),
    `tool path names an intent: ${names.join(" | ")}`,
  );

  const rows = (
    await client.query<{
      turn_id: string;
      verdict: string;
      ask_source: string;
      sentiment: string | null;
    }>(`select turn_id, verdict, ask_source, sentiment from trace_turn_topics`)
  ).rows;
  assert.equal(rows.length, 13);
  for (const row of rows) {
    assert.equal(row.ask_source, "derived");
    assert.equal(row.sentiment, null);
    assert.notEqual(row.verdict, "retry", "the same tool path in a row is not an ask repeated");
  }
  const [label] = (
    await client.query<{ ask_hash: string }>(
      `select ask_hash from trace_turn_topics where turn_id = $1`,
      [labelled],
    )
  ).rows;
  assert.equal(
    label?.ask_hash,
    hashText(normalizeAsk("Review failing traces")),
    "a labelled task's run reads the task's name",
  );
});

test("flag off: tool-only runs stay without an ask, as before", async () => {
  const { db } = await seed();
  const result = await assignProjectTopics(PROJECT_ID, deps(db, false));
  assert.equal(result.topics, 0);
  const reading = await loadTopicReading(PROJECT_ID, db);
  assert.equal(reading?.insights.verdicts.no_ask, 13);
  assert.equal(reading?.insights.sources.derived ?? 0, 0);
});
