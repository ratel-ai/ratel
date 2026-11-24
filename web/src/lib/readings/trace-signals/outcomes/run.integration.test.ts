import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { TimeBudgetError } from "@/lib/ledger/turn-pages";
import { OUTCOME_RULE_VERSION } from "@/lib/readings/trace-signals/outcomes/kinds";
import {
  type OutcomeRunDeps,
  recordOutcomes,
  type StoredOutcomes,
} from "@/lib/readings/trace-signals/outcomes/run";
import { outcomeRunDeps } from "@/lib/readings/trace-signals/outcomes/run-job";
import {
  loadSessionTurns,
  loadTaskVerdicts,
  replaceSessionOutcomes,
  replaceTaskOutcomes,
  replaceTurnOutcomes,
  writeReplyReactions,
} from "@/lib/readings/trace-signals/outcomes/run-queries";
import {
  loadNextScopeReplies,
  loadTurnReplies,
} from "@/lib/readings/trace-signals/outcomes/text-queries";
import { computeProjectTraceSignals } from "@/lib/readings/trace-signals/signals/compute-job";
import {
  count,
  type Db,
  jobDeps,
  outcomeTestDeps,
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { latestSignalRun } from "@/lib/readings/trace-signals/signals/queries";
import { fresh, times } from "@/lib/readings/trace-signals/signals/test-fixtures";

/**
 * One signal run over a migrated database: the window's turn outcomes are
 * written from the ledger and the failed calls' error messages, their
 * sessions are folded, the counts land in the run summary, and no message
 * reaches a row. A second run gives the same rows and leaves the columns of
 * the other layers alone. A failed reading never fails the run.
 */

const NOW = new Date("2026-09-02T00:00:00Z");
const BASE = Date.parse("2026-09-01T09:00:00Z");

/** Invented error messages, one per failing tool. */
const MESSAGES: Record<string, string> = {
  update_task: "validation_failed",
  find_task: 'Task "T-1042" not found',
  send_report: "Internal server error",
  archive_board: "Something odd happened",
};

/**
 * 30 sessions of one run each. 0-11: update_task fails once and works on the
 * next try. 12-17: find_task fails and the run switches to list_tasks. 18-20:
 * send_report fails twice and nothing follows. 21: archive_board fails with a
 * message no pattern knows. 22: a search that lists nothing. 23-29: clean.
 */
function fixtures() {
  return times(30, (i) => {
    const run = fresh({ session: `s-${i.toString().padStart(2, "0")}`, start: BASE + i * 60_000 });
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
    if (i === 22) return run.search([]);
    return run.invoke("find_task").invoke("update_task");
  });
}

/** Ingest keeps the message in `error_message`; a replayed dump keeps it in the payload. Both are read. */
async function setMessages(client: PGlite): Promise<void> {
  for (const [tool, message] of Object.entries(MESSAGES)) {
    if (tool === "send_report") {
      await client.query(
        `update trace_events set payload = jsonb_build_object('error', $1::text) where type = 'invoke_error' and tool_id = $2`,
        [message, tool],
      );
    } else {
      await client.query(
        `update trace_events set error_message = $1 where type = 'invoke_error' and tool_id = $2`,
        [message, tool],
      );
    }
  }
}

async function seeded(): Promise<{ client: PGlite; db: Db }> {
  const { client, db } = await setupDb();
  await seedLedger(client, db, fixtures());
  await setMessages(client);
  return { client, db };
}

/** Every stored row but the time it was read, in a stable order. */
async function snapshot(client: PGlite): Promise<{ turns: unknown[]; sessions: unknown[] }> {
  const turns = await client.query(
    `select to_jsonb(o) - 'read_at' as row from trace_turn_outcomes o where project_id = '${PROJECT_ID}' order by session_id, started_at, turn_id`,
  );
  const sessions = await client.query(
    `select to_jsonb(s) - 'read_at' as row from trace_session_outcomes s where project_id = '${PROJECT_ID}' order by session_id`,
  );
  return { turns: turns.rows, sessions: sessions.rows };
}

interface TurnRow {
  session_id: string;
  cause: string | null;
  cause_source: string | null;
  followed: string | null;
  failures: {
    tool: string;
    ordinal: number;
    errors: number;
    cause: string | null;
    followed: string;
    recovered: boolean;
  }[];
  ok_calls: number;
  failed_calls: number;
  errors_unread: number;
  unmet_searches: number;
  rule_version: number;
}

async function turnRows(client: PGlite): Promise<Map<string, TurnRow>> {
  const result = await client.query<TurnRow>(
    `select session_id, cause, cause_source, followed, failures, ok_calls, failed_calls, errors_unread, unmet_searches, rule_version
     from trace_turn_outcomes where project_id = '${PROJECT_ID}'`,
  );
  return new Map(result.rows.map((row) => [row.session_id, row]));
}

const EXPECTED: StoredOutcomes = {
  version: 1,
  ruleVersion: OUTCOME_RULE_VERSION,
  trust: { runs: "all", sessions: true },
  turns: 30,
  sessions: 30,
  failedCalls: 25,
  errorsUnread: 0,
  causes: { bad_arguments: 12, wrong_reference: 6, tool_fault: 6, not_allowed: 0, other: 1 },
  otherShapes: 1,
  streaks: 22,
  // Every session folded is cut into tasks; without the person's words each turn is one, read from the trace.
  tasks: { completed: 7, completed_after_friction: 18, not_completed: 5, unknown: 0 },
  followed: { fixed_next_try: 12, fixed_after_detour: 0, switched_tool: 6, nothing_followed: 4 },
  unmetSearches: 1,
  catalogListings: 0,
  openRequests: 5,
  // From the trace alone: a call that worked is a completed turn, a failure nothing recovered from or a search with no call a failed one.
  fusion: {
    results: { completed: 25, completed_wrong: 0, failed: 5, refused: 0 },
    falseCompletions: 0,
    sessions: {
      resolved_clean: 7,
      resolved_after_friction: 18,
      gave_up: 4,
      blocked: 1,
      escalated: 0,
    },
    ruleOnlySessions: 30,
  },
  questionsOff: "no_key",
};

test("a run writes one row per turn and per session, and its counts into the run summary", async () => {
  const { client, db } = await seeded();
  const result = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, NOW),
  );
  assert.equal(result.outcome, "completed");

  const rows = await turnRows(client);
  assert.equal(rows.size, 30);
  assert.deepEqual(rows.get("s-00"), {
    session_id: "s-00",
    cause: "bad_arguments",
    cause_source: "rule",
    followed: "fixed_next_try",
    failures: [
      {
        tool: "update_task",
        ordinal: 2,
        errors: 1,
        cause: "bad_arguments",
        followed: "fixed_next_try",
        recovered: true,
      },
    ],
    ok_calls: 2,
    failed_calls: 1,
    errors_unread: 0,
    unmet_searches: 0,
    rule_version: OUTCOME_RULE_VERSION,
  });
  assert.deepEqual(
    [rows.get("s-12")?.cause, rows.get("s-12")?.followed],
    ["wrong_reference", "switched_tool"],
  );
  // Two failed tries are one streak, and the message kept in the payload is read too.
  assert.deepEqual(rows.get("s-18")?.failures, [
    {
      tool: "send_report",
      ordinal: 1,
      errors: 2,
      cause: "tool_fault",
      followed: "nothing_followed",
      recovered: false,
    },
  ]);
  assert.deepEqual([rows.get("s-21")?.cause, rows.get("s-21")?.cause_source], ["other", "rule"]);
  assert.deepEqual(
    [rows.get("s-22")?.unmet_searches, rows.get("s-22")?.cause, rows.get("s-22")?.followed],
    [1, null, null],
  );
  assert.deepEqual([rows.get("s-29")?.failures, rows.get("s-29")?.cause_source], [[], null]);

  assert.equal(
    await count(
      client,
      `select count(*)::int as n from trace_session_outcomes where project_id = '${PROJECT_ID}'`,
    ),
    30,
  );
  assert.equal(
    await count(client, `select count(*)::int as n from trace_session_outcomes where open_request`),
    5,
  );
  assert.equal(
    await count(
      client,
      `select coalesce(sum(friction_count), 0)::int as n from trace_session_outcomes`,
    ),
    23,
  );
  assert.equal(
    await count(
      client,
      `select count(*)::int as n from trace_session_outcomes s join trace_turn_outcomes o on o.turn_id = s.first_turn_id and o.turn_id = s.last_turn_id`,
    ),
    30,
  );

  const run = await latestSignalRun(PROJECT_ID, db);
  assert.deepEqual((run?.summary as { outcomes?: StoredOutcomes }).outcomes, EXPECTED);
  await client.close();
});

test("a search with no call after it: no fitting tool only when no listed tool does it and none was run later, else no task", async () => {
  const { client, db } = await setupDb();
  // Every turn is a search for deleting a task, offered only tools that do not.
  const search = (session: string, query = "delete task", hits = ["create_task", "get_task"]) =>
    fresh({ session, start: BASE }).search(hits, { query });
  const later = search("ran-later");
  await seedLedger(client, db, [
    search("unfit"),
    later,
    // Its own turn: two hours after the search.
    fresh({ after: later, gapMs: 7_200_000 }).invoke("get_task"),
    search("fits", "delete task", ["delete_task"]),
    search("no-verb", "task garbage"),
  ]);
  const result = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, NOW),
  );
  assert.equal(result.outcome, "completed");

  const turns = await client.query<{ session_id: string; unmet: number }>(
    `select session_id, sum(unmet_searches)::int as unmet from trace_turn_outcomes group by 1 order by 1`,
  );
  assert.deepEqual(
    turns.rows.map((row) => [row.session_id, row.unmet]),
    [
      ["fits", 0],
      ["no-verb", 0],
      ["ran-later", 0],
      ["unfit", 1],
    ],
  );
  // A turn that only searched is no task and gives its session no outcome.
  const tasks = await client.query<{ session_id: string; result: string; reason: string | null }>(
    `select session_id, result, reason from trace_task_outcomes order by 1`,
  );
  assert.deepEqual(
    tasks.rows.map((row) => [row.session_id, row.result, row.reason]),
    [
      ["ran-later", "completed", null],
      ["unfit", "not_completed", "no_tool"],
    ],
  );
  const sessions = await client.query<{ session_id: string; outcome: string | null }>(
    `select session_id, outcome from trace_session_outcomes order by 1`,
  );
  assert.deepEqual(
    sessions.rows.map((row) => [row.session_id, row.outcome]),
    [
      ["fits", null],
      ["no-verb", null],
      ["ran-later", "resolved_clean"],
      ["unfit", "blocked"],
    ],
  );
  await client.close();
});

test("no error message is stored: rows and the summary keep causes and counts", async () => {
  const { client, db } = await seeded();
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));
  const dump = await client.query<{ row: string }>(
    `select row_to_json(o)::text as row from trace_turn_outcomes o
     union all select row_to_json(s)::text from trace_session_outcomes s
     union all select row_to_json(r)::text from trace_signal_runs r`,
  );
  const text = dump.rows.map((r) => r.row).join("\n");
  for (const fragment of [
    "validation_failed",
    "T-1042",
    "not found",
    "Internal server",
    "odd happened",
  ]) {
    assert.ok(!text.includes(fragment), fragment);
  }
  await client.close();
});

test("the next run gives the same rows, and keeps the model's answers and a result they were part of", async () => {
  const { client, db } = await seeded();
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));
  const ruleOnly = await snapshot(client);
  // A rule-only run fuses from the trace: every turn has a result and every session an outcome, both marked as the rules'.
  assert.equal(
    await count(
      client,
      `select count(*)::int as n from trace_turn_outcomes where result is null or result_source <> 'rule'`,
    ),
    0,
  );
  assert.equal(
    await count(
      client,
      `select count(*)::int as n from trace_session_outcomes where outcome is null or outcome_source <> 'rule'`,
    ),
    0,
  );
  assert.equal(
    await count(
      client,
      `select count(*)::int as n from trace_session_outcomes where outcome = 'escalated'`,
    ),
    0,
  );

  await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, new Date(NOW.getTime() + 1_800_000)),
  );
  assert.deepEqual(await snapshot(client), ruleOnly);

  // What the model layer writes on the same rows.
  await client.query(
    `update trace_turn_outcomes set satisfaction = 'unsatisfied', reaction = 'corrects', claimed_done = true, request = true, model_version = 1, result = 'completed_wrong', result_source = 'model' where session_id = 's-00'`,
  );
  await client.query(
    `update trace_turn_outcomes set cause = 'missing_capability', cause_source = 'model' where session_id = 's-21'`,
  );

  const result = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, new Date(NOW.getTime() + 3_600_000)),
  );
  assert.equal(result.outcome, "completed");
  const turns = await client.query<{
    session_id: string;
    result: string;
    result_source: string;
    satisfaction: string | null;
    reaction: string | null;
    cause: string | null;
    cause_source: string | null;
  }>(
    `select session_id, result, result_source, satisfaction, reaction, cause, cause_source from trace_turn_outcomes where session_id in ('s-00', 's-21') order by session_id`,
  );
  // A reading with only the rules to go by keeps the answers and the result they decided, and a model's cause where the rules had none.
  assert.deepEqual(turns.rows, [
    {
      session_id: "s-00",
      result: "completed_wrong",
      result_source: "model",
      satisfaction: "unsatisfied",
      reaction: "corrects",
      cause: "bad_arguments",
      cause_source: "rule",
    },
    {
      session_id: "s-21",
      result: "failed",
      result_source: "rule",
      satisfaction: null,
      reaction: null,
      cause: "missing_capability",
      cause_source: "model",
    },
  ]);
  // The session of the corrected turn is read again from its rows: the person objected and nothing came after.
  const sessions = await client.query<{
    session_id: string;
    outcome: string;
    outcome_source: string;
  }>(
    `select session_id, outcome, outcome_source from trace_session_outcomes where session_id in ('s-00', 's-21') order by session_id`,
  );
  assert.deepEqual(sessions.rows, [
    { session_id: "s-00", outcome: "gave_up", outcome_source: "model" },
    { session_id: "s-21", outcome: "blocked", outcome_source: "rule" },
  ]);
  const settled = await snapshot(client);

  await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, new Date(NOW.getTime() + 7_200_000)),
  );
  assert.deepEqual(await snapshot(client), settled);
  await client.close();
});

test("once the error events are pruned, a row keeps the cause it read before", async () => {
  const { client, db } = await seeded();
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));
  const first = await snapshot(client);
  await client.query(
    `update trace_events set error_message = null, payload = '{}'::jsonb where type = 'invoke_error'`,
  );

  await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, new Date(NOW.getTime() + 3_600_000)),
  );
  assert.deepEqual(await snapshot(client), first);
  const run = await latestSignalRun(PROJECT_ID, db);
  const stored = (run?.summary as { outcomes?: StoredOutcomes }).outcomes;
  assert.deepEqual(
    [stored?.failedCalls, stored?.errorsUnread],
    [25, 25],
    "the summary says what this reading could read",
  );
  await client.close();
});

test("a window read as several users' calls mixed together loses its turn rows and their sessions' and tasks' rows", async () => {
  const { client, db } = await seeded();
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));
  assert.equal(await count(client, `select count(*)::int as n from trace_turn_outcomes`), 30);
  assert.equal(await count(client, `select count(*)::int as n from trace_task_outcomes`), 30);

  await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    {
      ...jobDeps(db, new Date(NOW.getTime() + 3_600_000)),
      recordOutcomes: (projectId, input, budget) =>
        recordOutcomes(projectId, input, {
          ...outcomeRunDeps(budget, null),
          loadBasis: async () => ({
            basis: "none",
            blocked: "mixed_runs",
            excludedRuns: 0,
            since: null,
            mixed: true,
          }),
          replaceTurnRows: (p, range, rows, at) => replaceTurnOutcomes(p, range, rows, at, db),
          loadSessionTurns: (p, ids) => loadSessionTurns(p, ids, db),
          replaceSessionRows: (p, ids, rows, at) => replaceSessionOutcomes(p, ids, rows, at, db),
          loadTaskVerdicts: (p, ids) => loadTaskVerdicts(p, ids, db),
          replaceTaskRows: (p, ids, rows, at) => replaceTaskOutcomes(p, ids, rows, at, db),
          loadReplyTexts: (p, turns) => loadTurnReplies(p, turns, db),
          loadNextScopeReplies: (p, turns) => loadNextScopeReplies(p, turns, db),
          writeReplyReactions: (p, rows) => writeReplyReactions(p, rows, db),
        }),
    },
  );
  assert.equal(await count(client, `select count(*)::int as n from trace_turn_outcomes`), 0);
  assert.equal(await count(client, `select count(*)::int as n from trace_session_outcomes`), 0);
  // The page reads tasks by project and time: a task of a session no longer read would still count.
  assert.equal(await count(client, `select count(*)::int as n from trace_task_outcomes`), 0);
  await client.close();
});

test("a reading that fails or runs out of time never fails the run, and leaves the rows as they were", async () => {
  const { client, db } = await seeded();
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));
  const first = await snapshot(client);

  for (const error of [new Error("boom"), new TimeBudgetError()]) {
    const result = await computeProjectTraceSignals(
      PROJECT_ID,
      { trigger: "manual" },
      {
        ...jobDeps(db, new Date(NOW.getTime() + 3_600_000)),
        recordOutcomes: async () => {
          throw error;
        },
      },
    );
    assert.equal(result.outcome, "completed");
    const run = await latestSignalRun(PROJECT_ID, db);
    assert.equal((run?.summary as { outcomes?: StoredOutcomes }).outcomes, undefined);
    assert.deepEqual(await snapshot(client), first);
  }
  await client.close();
});

test("where only the agent's replies are captured, the next reply says how the person took a turn, and the session and the task read it", async () => {
  const { client, db } = await setupDb();
  const first = fresh({ session: "s-r", turnId: "r1", traceId: "tr-r1", start: BASE }).invoke(
    "manage_project",
  );
  const second = fresh({ after: first, turnId: "r2", traceId: "tr-r2", gapMs: 120_000 }).invoke(
    "manage_project",
  );
  await seedLedger(client, db, [first, second]);
  // Content capture: the model calls, whole. The person's own messages were not sent.
  const reply = (trace: string, text: string) =>
    client.query(
      `insert into events (project_id, received_at, occurred_at, trace_id, payload) values ($1::uuid, $2::timestamptz, $2::timestamptz, $3, $4::jsonb)`,
      [
        PROJECT_ID,
        new Date(BASE + 200_000).toISOString(),
        trace,
        JSON.stringify({
          messages: [
            { role: "user", content: "[not sent]" },
            { role: "assistant", content: [{ type: "text", text }] },
          ],
        }),
      ],
    );
  await reply("tr-r1", "Archived Onboarding v2.");
  await reply(
    "tr-r2",
    "You're right, that was the wrong one. Restored v2 and archived Onboarding 2024 instead.",
  );
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));

  const rows = await client.query<{
    turn_key: string;
    reply_reaction: string | null;
    reply_reaction_source: string | null;
  }>(
    `select t.turn_key, o.reply_reaction, o.reply_reaction_source from trace_turn_outcomes o join trace_turns t on t.id = o.turn_id order by o.started_at`,
  );
  assert.deepEqual(
    rows.rows.map((row) => [row.turn_key, row.reply_reaction, row.reply_reaction_source]),
    [
      ["declared:r1", "corrects", "rule"],
      ["declared:r2", null, null],
    ],
  );
  const tasks = await client.query<{ tier: string; result: string; reason: string | null }>(
    `select tier, result, reason from trace_task_outcomes order by started_at`,
  );
  assert.deepEqual(tasks.rows[0], { tier: "tr", result: "not_completed", reason: "wrong_action" });
  const session = await client.query<{ outcome: string }>(
    `select outcome from trace_session_outcomes`,
  );
  assert.equal(
    session.rows[0]?.outcome,
    "resolved_after_friction",
    "corrected on the way, then the last turn stood",
  );

  const reactions = async () =>
    (
      await client.query<{
        turn_key: string;
        reply_reaction: string | null;
        source: string | null;
      }>(
        `select t.turn_key, o.reply_reaction, o.reply_reaction_source as source from trace_turn_outcomes o join trace_turns t on t.id = o.turn_id order by o.started_at`,
      )
    ).rows.map((row) => [row.turn_key, row.reply_reaction, row.source]);
  const settled = await reactions();
  const rerun = (at: number, over: Partial<OutcomeRunDeps> = {}) =>
    computeProjectTraceSignals(
      PROJECT_ID,
      { trigger: "manual" },
      {
        ...jobDeps(db, new Date(NOW.getTime() + at)),
        recordOutcomes: (projectId, input, budget) =>
          recordOutcomes(projectId, input, outcomeTestDeps(db, budget, over)),
      },
    );

  // Replies that cannot be read this time leave what was read before.
  await rerun(3_600_000, {
    loadReplyTexts: async () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(await reactions(), settled);

  // A reading with only the rules to go by keeps the model's reading of a reply, as it keeps a model's result.
  await client.query(
    `update trace_turn_outcomes o set reply_reaction = 'repeats', reply_reaction_source = 'model' from trace_turns t where t.id = o.turn_id and t.turn_key = 'declared:r1'`,
  );
  await rerun(7_200_000);
  assert.deepEqual(await reactions(), [
    ["declared:r1", "repeats", "model"],
    ["declared:r2", null, null],
  ]);
  await client.close();
});
