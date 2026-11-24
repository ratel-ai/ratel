import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { computeProjectTraceSignals } from "@/lib/readings/trace-signals/signals/compute-job";
import {
  type Db,
  jobDeps,
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { fresh, times } from "@/lib/readings/trace-signals/signals/test-fixtures";
import { loadSentimentPage } from "@/lib/views/traces/sentiment/page-load";
import {
  DEFAULT_SENTIMENT_QUERY,
  NO_SENTIMENT_FILTERS,
} from "@/lib/views/traces/sentiment/page-paths";

/**
 * The page over a migrated database: a signal run writes the outcome rows,
 * the intent engine's assignments and a model's answers are seeded beside
 * them, and the page reads them back as task completion with its reasons and
 * root causes, what the person's words showed, and the intents. No text is
 * seeded or read.
 */

const NOW = new Date("2026-09-02T00:00:00Z");
const BASE = Date.parse("2026-09-01T09:00:00Z");

const MESSAGES: Record<string, string> = {
  update_task: "validation_failed",
  find_task: 'Task "T-1042" not found',
  send_report: "Internal server error",
  archive_board: "Something odd happened",
};

const GROUP = "aaaaaaaa-0000-4000-8000-000000000001";
const WAY = "aaaaaaaa-0000-4000-8000-000000000002";
const LONE = "aaaaaaaa-0000-4000-8000-000000000003";

/**
 * 30 sessions of one run each, every run opening with a search. 0-11:
 * update_task fails once and works on the next try. 12-17: find_task fails and
 * the run switches to list_tasks. 18-20: send_report fails twice and nothing
 * follows. 21: archive_board fails with a message no pattern knows. 22: a
 * search that lists nothing. 23-29: clean.
 */
function fixtures() {
  return times(30, (i) => {
    // Sessions 6-10 declare their turn, as an SDK turn scope does.
    const turnId = i >= 6 && i <= 10 ? `turn-${i}` : null;
    const run = fresh({
      session: `s-${i.toString().padStart(2, "0")}`,
      start: BASE + i * 60_000,
      turnId,
    }).search(i === 22 ? [] : ["find_task", "update_task"]);
    if (i < 12)
      return run
        .invoke("find_task")
        .invoke("update_task")
        .error("update_task")
        .invoke("update_task");
    if (i < 18) return run.invoke("find_task").error("find_task").invoke("list_tasks");
    if (i < 21)
      return run
        .invoke("send_report")
        .error("send_report")
        .invoke("send_report")
        .error("send_report");
    if (i === 21) return run.invoke("archive_board").error("archive_board");
    if (i === 22) return run;
    return run.invoke("find_task").invoke("update_task");
  });
}

async function seeded(): Promise<{ client: PGlite; db: Db }> {
  const { client, db } = await setupDb();
  await seedLedger(client, db, fixtures());
  for (const [tool, message] of Object.entries(MESSAGES)) {
    await client.query(
      `update trace_events set error_message = $1 where type = 'invoke_error' and tool_id = $2`,
      [message, tool],
    );
  }
  const result = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, NOW),
  );
  assert.equal(result.outcome, "completed");

  // Sessions 0-5 happened two weeks earlier.
  await client.exec(`
    update trace_turn_outcomes set started_at = started_at - interval '14 days', ended_at = ended_at - interval '14 days' where session_id < 's-06';
    update trace_session_outcomes set started_at = started_at - interval '14 days', ended_at = ended_at - interval '14 days' where session_id < 's-06';
    update trace_task_outcomes set started_at = started_at - interval '14 days', ended_at = ended_at - interval '14 days' where session_id < 's-06';
  `);

  // The engine placed the searches of sessions 0-11 in a way of asking under a named group, and those of 12-17 in a cluster with no group.
  await client.exec(`
    insert into intent_clusters (id, project_id, level, label, llm_label, children) values
      ('${GROUP}', '${PROJECT_ID}', 1, 'update task', 'Update a task', '["${WAY}"]'::jsonb),
      ('${LONE}', '${PROJECT_ID}', 0, 'find a task', null, '[]'::jsonb);
    insert into intent_clusters (id, project_id, level, parent_id, label) values ('${WAY}', '${PROJECT_ID}', 0, '${GROUP}', 'mark task done');
    insert into intent_cluster_assignments (project_id, trace_event_id, cluster_id, kind, session_id, occurred_at)
    select s.project_id, s.trace_event_id, case when t.session_id < 's-12' then '${WAY}'::uuid else '${LONE}'::uuid end, 'search', t.session_id, s.occurred_at
      from trace_turn_steps s join trace_turns t on t.id = s.turn_id
     where s.kind = 'search' and s.ordinal = 1 and t.session_id < 's-18';
  `);
  return { client, db };
}

/**
 * A model's answers on a few turns, a fused outcome on one session, and the
 * turn scopes that sent a message: the five declared turns, and one more whose
 * turn made no call and so has no turn row.
 */
async function withText(client: PGlite): Promise<void> {
  await client.exec(`
    update trace_turn_outcomes set satisfaction = 'unsatisfied', reaction = 'repeats', model_version = 1 where session_id in ('s-06', 's-07');
    update trace_turn_outcomes set satisfaction = 'satisfied', reaction = 'new_request', model_version = 1 where session_id = 's-08';
    update trace_turn_outcomes set satisfaction = 'unsatisfied', reaction = 'gives_up', model_version = 1 where session_id = 's-25';
    update trace_turn_outcomes set cause = 'false_success', cause_source = 'model' where session_id = 's-21';
    update trace_turn_outcomes set cause = 'correct_refusal', cause_source = 'model', satisfaction = 'unknown', reaction = 'asks_human' where session_id = 's-26';
    update trace_session_outcomes set outcome = 'escalated', outcome_source = 'model' where session_id = 's-29';
  `);
  for (let i = 6; i <= 11; i += 1) {
    await client.query(
      `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, client_event_id, payload)
       values (gen_random_uuid(), $1, 'turn_start', $2, $3, $3, $4, jsonb_build_object('user_message', 'x', 'turn_id', $5::text))`,
      [
        PROJECT_ID,
        `s-${i.toString().padStart(2, "0")}`,
        new Date(BASE + i * 60_000).toISOString(),
        `start-${i}`,
        i === 11 ? "turn-without-calls" : `turn-${i}`,
      ],
    );
  }
}

const load = (db: Db, over: Partial<Parameters<typeof loadSentimentPage>[0]> = {}) =>
  loadSentimentPage({
    projectId: PROJECT_ID,
    windowDays: 30,
    query: DEFAULT_SENTIMENT_QUERY,
    now: NOW,
    db,
    modelConfigured: false,
    minSessions: 3,
    ...over,
  });

const reasonsOf = (page: Awaited<ReturnType<typeof load>>) =>
  page.overview.reasons.map((entry) => [entry.result, entry.reason, entry.tasks]);

test("a project without user text: task completion, its reasons and root causes, read by rules", async () => {
  const { db } = await seeded();
  const page = await load(db);

  assert.equal(page.state, "ready");
  // 30 sessions of one task each: 0-17 recovered on the way, 18-21 ended on a failed call, 22 ran nothing, 23-29 clean.
  assert.deepEqual(
    [page.overview.tasks, page.overview.completed, page.overview.notCompleted],
    [30, 25, 5],
  );
  assert.deepEqual(reasonsOf(page), [
    ["not_completed", "failed_call", 4],
    ["not_completed", "no_tool", 1],
    ["completed_after_friction", "recovered_call", 18],
  ]);
  const failed = page.overview.groups.find((group) => group.reason === "failed_call")!;
  assert.deepEqual(
    failed.rows.map((row) => [row.cause, row.tool, row.tasks]),
    [
      ["tool_fault", "send_report", 3],
      ["other", "archive_board", 1],
    ],
  );
  assert.deepEqual(page.text, {
    state: "no_text",
    textTurns: 0,
    answeredTurns: 0,
    satisfactionTurns: 0,
    satisfaction: null,
    score: null,
    reactions: null,
    inferred: null,
  });
  assert.equal(page.intentScores, null, "no answers, nothing to rank");
});

test("a week, a session outcome and a shorter window narrow the tasks", async () => {
  const { db } = await seeded();
  const week = await load(db, {
    query: { ...DEFAULT_SENTIMENT_QUERY, filters: { ...NO_SENTIMENT_FILTERS, week: "2026-08-17" } },
  });
  assert.deepEqual(
    [week.overview.tasks, week.overview.completed],
    [6, 6],
    "sessions 0-5, two weeks back",
  );
  const gaveUp = await load(db, {
    query: { ...DEFAULT_SENTIMENT_QUERY, filters: { ...NO_SENTIMENT_FILTERS, outcome: "gave_up" } },
  });
  assert.deepEqual(reasonsOf(gaveUp), [["not_completed", "failed_call", 4]]);
  // A 7-day window leaves the two-week-old sessions out.
  const recent = await load(db, { windowDays: 7 });
  assert.equal(recent.overview.tasks, 24);
});

test("a project with user text: the model's answers reach the text state, satisfaction and the intents", async () => {
  const { client, db } = await seeded();
  await withText(client);
  const page = await load(db, { modelConfigured: true });

  assert.deepEqual(page.text, {
    state: "capped",
    textTurns: 5,
    answeredTurns: 4,
    satisfactionTurns: 5,
    satisfaction: { satisfied: 1, neutral: 0, unsatisfied: 3, unknown: 1 },
    // Satisfied in 1 of the 4 turns the person said how it went.
    score: 0.25,
    reactions: {
      satisfied: 0,
      corrects: 0,
      repeats: 2,
      gives_up: 1,
      asks_human: 1,
      takes_over: 0,
      new_request: 1,
      unknown: 0,
    },
    inferred: null,
  });
  // Every turn people reacted to counts, the undecided one too: of five, two were not pushed back on.
  assert.deepEqual(
    [page.overview.satisfaction.answers, page.overview.satisfaction.satisfied],
    [5, 2],
  );
  assert.ok(page.intentScores, "messages were read, so intents are ranked");
  assert.deepEqual(
    page.intentScores.unsatisfied.map((score) => [score.intent.label, score.said]),
    // s-06 and s-07 unsatisfied, s-08 satisfied.
    [["Update a task", 3]],
  );

  const off = await load(db, { modelConfigured: false });
  assert.equal(off.text.state, "capped", "answers already stored still show without a key");
});

test("a project with no outcome rows is the empty page", async () => {
  const { db } = await setupDb();
  const page = await load(db);
  assert.equal(page.state, "empty");
  assert.equal(page.overview.tasks, 0);
});

test("cost is the model calls of each turn's traces, a shared trace split between its turns; without a costed call there is none", async () => {
  const { client, db } = await seeded();
  const before = await load(db, { query: { ...DEFAULT_SENTIMENT_QUERY, sort: "cost" } });
  assert.equal(before.costKnown, false);
  assert.equal(before.query.sort, "impact", "nothing to order by cost yet");
  assert.equal(before.overview.failure.costUsd, null);

  // Each session runs in its own trace; sessions 19 and 20 share one. The send_report sessions' model calls cost 0.25 a trace.
  await client.exec(`
    update trace_events set trace_id = case when session_id in ('s-19', 's-20') then 'tr-shared' else 'tr-' || session_id end;
    insert into events (project_id, received_at, occurred_at, trace_id, cost_usd) values
      ('${PROJECT_ID}', '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z', 'tr-s-18', 0.25),
      ('${PROJECT_ID}', '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z', 'tr-shared', 0.25),
      ('${PROJECT_ID}', '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z', 'tr-s-12', 0.01);
  `);
  const page = await load(db, { query: { ...DEFAULT_SENTIMENT_QUERY, sort: "cost" } });
  assert.equal(page.costKnown, true);
  assert.equal(page.query.sort, "cost");
  assert.ok(
    Math.abs((page.overview.failure.costUsd ?? 0) - 0.5) < 1e-9,
    "0.25 for s-18, and the shared 0.25 once over s-19 and s-20",
  );
  const report = page.overview.groups
    .flatMap((group) => group.rows)
    .find((row) => row.tool === "send_report");
  assert.ok(report && Math.abs((report.costUsd ?? 0) - 0.5) < 1e-9);
});

test("an intent is read at level 2 when the engine built one, else at level 1, else the cluster", async () => {
  const { client, db } = await seeded();
  const AREA = "aaaaaaaa-0000-4000-8000-000000000004";
  await client.exec(`
    insert into intent_clusters (id, project_id, level, label, llm_label, children) values ('${AREA}', '${PROJECT_ID}', 2, 'task', 'Task operations', '["${GROUP}"]'::jsonb);
    update intent_clusters set parent_id = '${AREA}' where id = '${GROUP}';
  `);
  const named = async (intent: string) =>
    (
      await load(db, {
        query: { ...DEFAULT_SENTIMENT_QUERY, filters: { ...NO_SENTIMENT_FILTERS, intent } },
      })
    ).intentLabel;
  assert.equal(await named(AREA), "Task operations", "the level-2 group names the turns under it");
  assert.equal(await named(GROUP), GROUP, "its level-1 group is not used once a level 2 exists");
  assert.equal(await named(LONE), "find a task", "a cluster with no group keeps its own name");
  // Task completion follows the intent of each task's first turn.
  const area = await load(db, {
    query: { ...DEFAULT_SENTIMENT_QUERY, filters: { ...NO_SENTIMENT_FILTERS, intent: AREA } },
  });
  assert.equal(area.overview.tasks, 12);
});

test("the reading stores one task per turn without the person's words, and a reason narrows the root causes to it", async () => {
  const { db } = await seeded();
  const narrowed = await load(db, {
    query: {
      ...DEFAULT_SENTIMENT_QUERY,
      filters: { ...NO_SENTIMENT_FILTERS, task: "not_completed", reason: "failed_call" },
    },
  });
  assert.deepEqual(
    narrowed.overview.groups.map((group) => group.reason),
    ["failed_call"],
  );
  assert.ok(
    narrowed.overview.groups
      .flatMap((group) => group.rows)
      .every((row) => row.cause !== "missing_capability"),
    "a search with nothing run is another reason",
  );
  // The reason choices are counted before the filters, so picking one keeps the others.
  assert.equal(narrowed.overview.reasons.length, 3);
});
