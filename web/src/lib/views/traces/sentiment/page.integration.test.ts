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
 * the intent engine's assignments, the catalog versions and a model's answers
 * are seeded beside them, and the page reads them back as ranked root causes,
 * the session split and the four cuts. No text is seeded or read.
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
 * search and no call. 23-29: clean.
 */
function fixtures() {
  return times(30, (i) => {
    // Sessions 6-10 declare their turn, as an SDK turn scope does.
    const turnId = i >= 6 && i <= 10 ? `turn-${i}` : null;
    const run = fresh({
      session: `s-${i.toString().padStart(2, "0")}`,
      start: BASE + i * 60_000,
      turnId,
    }).search(["find_task", "update_task"]);
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

  // Sessions 0-5 happened two weeks earlier, on the first catalog version.
  await client.exec(`
    update trace_turn_outcomes set started_at = started_at - interval '14 days', ended_at = ended_at - interval '14 days' where session_id < 's-06';
    update trace_session_outcomes set started_at = started_at - interval '14 days', ended_at = ended_at - interval '14 days' where session_id < 's-06';
    update trace_events set catalog_version = case when session_id < 's-06' then 'v1' else 'v2' end;
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

test("a project without user text: rule-read root causes ranked, thin rows hidden, weekly trends and the catalog version a row started on", async () => {
  const { db } = await seeded();
  const page = await load(db);

  assert.equal(page.state, "ready");
  assert.deepEqual(page.weeks, [
    "2026-08-03",
    "2026-08-10",
    "2026-08-17",
    "2026-08-24",
    "2026-08-31",
  ]);
  assert.deepEqual(
    page.rows.map((row) => [
      row.intent?.label ?? null,
      row.cause,
      row.tool,
      row.sessions,
      row.unresolved,
      row.owner,
      row.readBy,
    ]),
    [
      [null, "tool_fault", "send_report", 3, 3, "tool_owner", "rule"],
      ["Update a task", "bad_arguments", "update_task", 12, 0, "prompt", "rule"],
      ["find a task", "wrong_reference", "find_task", 6, 0, "prompt", "rule"],
    ],
  );
  const update = page.rows[1]!;
  assert.equal(update.intent?.id, GROUP, "the intent is the way's group");
  assert.deepEqual(update.trend, [0, 0, 6, 0, 6]);
  assert.equal(update.startedVersion, "v1");
  assert.equal(update.failedCalls, 12);
  assert.equal(page.rows[0]?.failedCalls, 6);
  assert.equal(page.rows[0]?.startedVersion, "v2");
  assert.equal(page.rows[0]?.examples.length, 3);

  // archive_board (one session) and the search nothing was run for (one session) are under the minimum.
  assert.deepEqual(page.hidden, { rows: 2, sessions: 2, folded: 0 });
  assert.deepEqual(page.totals, { sessions: 30, turns: 30, affected: 23, unresolved: 5 });

  // Gave up: 18-20 and 21 ended on a failed call. Blocked: s-22 ended on a search nothing was
  // run for, a need the catalog cannot serve (`sessionOutcome` in fusion.ts).
  assert.deepEqual(
    page.split.classes.map((c) => [c.outcome, c.sessions]),
    [
      ["resolved_clean", 7],
      ["resolved_after_friction", 18],
      ["gave_up", 4],
      ["blocked", 1],
      ["escalated", 0],
    ],
  );
  assert.equal(page.split.readBy, "rule");
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

  assert.deepEqual(
    page.cuts.intent.values.map((v) => [v.label, v.sessions, v.unresolved]),
    [
      ["Update a task", 12, 0],
      ["find a task", 6, 0],
      ["No intent", 5, 5],
    ],
  );
  assert.deepEqual(
    page.cuts.tool.values.map((v) => [v.key, v.sessions]),
    [
      ["update_task", 12],
      ["find_task", 6],
      ["send_report", 3],
      ["archive_board", 1],
    ],
  );
  assert.deepEqual(
    page.cuts.version.values.map((v) => [v.key, v.sessions]),
    [
      ["v1", 6],
      ["v2", 17],
    ],
  );
  assert.deepEqual(
    page.cuts.week.values.map((v) => [v.key, v.sessions]),
    [
      ["2026-08-03", 0],
      ["2026-08-10", 0],
      ["2026-08-17", 6],
      ["2026-08-24", 0],
      ["2026-08-31", 17],
    ],
  );
});

test("thin rows show when asked for, and a filter narrows the list to its sessions", async () => {
  const { db } = await seeded();
  const thin = await load(db, { query: { ...DEFAULT_SENTIMENT_QUERY, thin: true } });
  assert.deepEqual(
    thin.rows.filter((row) => row.thin).map((row) => [row.cause, row.tool, row.sessions]),
    [
      ["missing_capability", null, 1],
      ["other", "archive_board", 1],
    ],
  );

  const week = await load(db, {
    query: { ...DEFAULT_SENTIMENT_QUERY, filters: { ...NO_SENTIMENT_FILTERS, week: "2026-08-17" } },
  });
  assert.deepEqual(
    week.rows.map((row) => [row.tool, row.sessions]),
    [["update_task", 6]],
  );
  assert.equal(week.totals.sessions, 6);

  const version = await load(db, {
    query: {
      ...DEFAULT_SENTIMENT_QUERY,
      sort: "sessions",
      filters: { ...NO_SENTIMENT_FILTERS, version: "v2" },
    },
  });
  assert.deepEqual(
    version.rows.map((row) => [row.tool, row.sessions]),
    [
      ["update_task", 6],
      ["find_task", 6],
      ["send_report", 3],
    ],
  );

  // A 7-day window leaves the two-week-old sessions out.
  const recent = await load(db, { windowDays: 7 });
  assert.equal(recent.totals.sessions, 24);
  assert.deepEqual(recent.rows.find((row) => row.tool === "update_task")?.sessions, 6);
});

test("a project with user text: the model's answers reach the rows, the split and the text state", async () => {
  const { client, db } = await seeded();
  await withText(client);
  const page = await load(db, {
    modelConfigured: true,
    query: { ...DEFAULT_SENTIMENT_QUERY, thin: true },
  });

  const update = page.rows.find((row) => row.tool === "update_task")!;
  assert.deepEqual(
    [update.sessions, update.unresolved, update.answered, update.unsatisfied],
    [12, 2, 3, 2],
  );
  assert.deepEqual(update.reactions, { repeats: 2, new_request: 1 });
  assert.deepEqual(
    update.examples
      .slice(0, 2)
      .map((example) => example.sessionId)
      .sort(),
    ["s-06", "s-07"],
  );

  // The rules left archive_board's message open; the model's cause names it.
  const archive = page.rows.find((row) => row.tool === "archive_board")!;
  assert.deepEqual(
    [archive.cause, archive.owner, archive.readBy],
    ["false_success", "prompt", "model"],
  );
  // Every call worked and the agent was right to refuse: listed, read by the model, and not unresolved.
  const refused = page.rows.find((row) => row.cause === "correct_refusal")!;
  assert.deepEqual(
    [
      refused.tool,
      refused.sessions,
      refused.unresolved,
      refused.owner,
      refused.reactions.asks_human,
    ],
    [null, 1, 0, "nobody", 1],
  );
  // Every call worked and the person gave up: a row with no tool, read by the model.
  const quiet = page.rows.find((row) => row.cause === "no_failure")!;
  assert.deepEqual(
    [quiet.tool, quiet.sessions, quiet.unresolved, quiet.readBy, quiet.reactions.gives_up],
    [null, 1, 1, "model", 1],
  );

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
  assert.equal(page.split.readBy, "mixed");
  // The person asked for a human after a correct refusal, and said nothing about satisfaction there.
  assert.deepEqual(
    page.split.classes.find((c) => c.outcome === "escalated"),
    { outcome: "escalated", sessions: 1, share: 1 / 30, score: null, said: 0 },
  );
  const said = page.split.classes.reduce((sum, c) => sum + c.said, 0);
  const satisfied = page.split.classes.reduce((sum, c) => sum + (c.score ?? 0) * c.said, 0);
  // Every turn people reacted to counts, the undecided one too: of five, two were not pushed back on.
  assert.deepEqual([said, Math.round(satisfied)], [5, 2]);
  assert.ok(page.intentScores, "messages were read, so intents are ranked");

  const off = await load(db, { modelConfigured: false });
  assert.equal(off.text.state, "capped", "answers already stored still show without a key");
});

test("a project with no outcome rows is the empty page", async () => {
  const { db } = await setupDb();
  const page = await load(db);
  assert.equal(page.state, "empty");
  assert.deepEqual(page.rows, []);
  assert.equal(page.split.total, 0);
});

test("cost is the model calls of each turn's traces, a shared trace split between its turns; without a costed call there is none", async () => {
  const { client, db } = await seeded();
  const before = await load(db, { query: { ...DEFAULT_SENTIMENT_QUERY, sort: "cost" } });
  assert.equal(before.costKnown, false);
  assert.equal(before.query.sort, "impact", "nothing to order by cost yet");
  assert.ok(before.rows.every((row) => row.costUsd === null));
  assert.ok(before.rows.every((row) => row.timeMs >= 0));

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
  const report = page.rows.find((row) => row.tool === "send_report");
  assert.ok(
    report && Math.abs((report.costUsd ?? 0) - 0.5) < 1e-9,
    "0.25 for s-18, and the shared 0.25 once over s-19 and s-20",
  );
  assert.equal(page.groups[0]?.cause, "tool_fault", "the costliest cause leads");
  assert.equal(
    page.rows.find((row) => row.tool === "update_task")?.costUsd,
    0,
    "a row with no costed call costs nothing",
  );
});

test("an intent is read at level 2 when the engine built one, else at level 1, else the cluster", async () => {
  const { client, db } = await seeded();
  const AREA = "aaaaaaaa-0000-4000-8000-000000000004";
  await client.exec(`
    insert into intent_clusters (id, project_id, level, label, llm_label, children) values ('${AREA}', '${PROJECT_ID}', 2, 'task', 'Task operations', '["${GROUP}"]'::jsonb);
    update intent_clusters set parent_id = '${AREA}' where id = '${GROUP}';
  `);
  const page = await load(db, { query: { ...DEFAULT_SENTIMENT_QUERY, thin: true } });
  const labels = new Set(page.rows.map((row) => row.intent?.label ?? null));
  assert.ok(labels.has("Task operations"), "the level-2 group names the turns under it");
  assert.ok(!labels.has("Update a task"), "its level-1 group is not used once a level 2 exists");
  assert.ok(labels.has("find a task"), "a cluster with no group keeps its own name");
  assert.equal(page.rows.find((row) => row.intent?.label === "Task operations")?.intent?.id, AREA);
});

test("the reading stores one task per turn without the person's words, and the page splits them and narrows to a reason", async () => {
  const { db } = await seeded();
  const page = await load(db);
  // 30 sessions of one run each, every run opening with a search: 30 tasks, each read against its search.
  assert.equal(page.tasks.total, 30);
  assert.deepEqual(page.tasks.tiers, { t0: 0, t1: 30, tr: 0, t2: 0, t3: 0 });
  const byFilter = Object.fromEntries(page.tasks.classes.map((c) => [c.filter, c.tasks]));
  // Without the task question nothing checks the goal; the page counts the tasks that ended working as completed.
  assert.ok(byFilter.completed! > 0);
  assert.ok(byFilter.not_completed! > 0);
  const reasons = page.tasks.reasons.map((r) => r.reason);
  assert.ok(reasons.includes("failed_call"));
  const narrowed = await load(db, {
    query: {
      ...DEFAULT_SENTIMENT_QUERY,
      filters: { ...NO_SENTIMENT_FILTERS, task: "not_completed", reason: "failed_call" },
    },
  });
  assert.ok(narrowed.rows.length > 0);
  assert.ok(
    narrowed.rows.every((row) => row.cause !== "missing_capability"),
    "a search with nothing run is another reason",
  );
});
