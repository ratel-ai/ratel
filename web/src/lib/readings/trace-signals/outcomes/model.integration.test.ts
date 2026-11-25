import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import type { ClosedQuestionClient, ClosedQuestionRequest } from "@/lib/contracts/closed-questions";
import { listClosedTurnsPage } from "@/lib/ledger/closed-turns";
import type { AskDeps } from "@/lib/readings/trace-signals/outcomes/ask";
import {
  loadOutcomeVerdicts,
  saveOutcomeVerdicts,
} from "@/lib/readings/trace-signals/outcomes/ask-queries";
import type { ModelReadDeps } from "@/lib/readings/trace-signals/outcomes/model-read";
import type { TurnAnswerRow } from "@/lib/readings/trace-signals/outcomes/questions";
import { recordOutcomes, type StoredOutcomes } from "@/lib/readings/trace-signals/outcomes/run";
import { outcomeRunDeps } from "@/lib/readings/trace-signals/outcomes/run-job";
import {
  loadErrorMessages,
  loadLastCalls,
  loadSessionTurns,
  loadTaskVerdicts,
  replaceSessionOutcomes,
  replaceTaskOutcomes,
  replaceTurnOutcomes,
  writeReplyReactions,
  writeTurnAnswers,
  writeTurnResults,
} from "@/lib/readings/trace-signals/outcomes/run-queries";
import {
  loadNextScopeReplies,
  loadReplies,
  loadSearchQueries,
  loadSessionMessages,
  loadTurnReplies,
} from "@/lib/readings/trace-signals/outcomes/text-queries";
import { loadRunBasisCounts } from "@/lib/readings/trace-signals/signals/analysis-context";
import { computeProjectTraceSignals } from "@/lib/readings/trace-signals/signals/compute-job";
import {
  count,
  type Db,
  jobDeps,
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { latestSignalRun } from "@/lib/readings/trace-signals/signals/queries";
import { fresh } from "@/lib/readings/trace-signals/signals/test-fixtures";
import { chooseRunBasis } from "@/lib/readings/trace-signals/workflows/run-basis";

/** The model a fake client answers as; the answer cache keeps it beside each answer. */
const SAGE2_MODEL = "closed-question-model";

/**
 * A signal run over a migrated database with the model layer on, against a
 * fake Sage client: without a key no call is made and the rows are
 * rule-only; with one, fresh questions stay under the cap, their closed
 * answers land on the rows, a second run of the same window asks nothing
 * fresh, and no text reaches a table. All text here is invented.
 */

const NOW = new Date("2026-09-02T00:00:00Z");
const BASE = Date.parse("2026-09-01T09:00:00Z");

interface Said {
  session: string;
  turnId: string;
  at: number;
  text: string;
  reply?: string;
}

/**
 * s-a: a request that goes well, a second request, then a thanks with no call.
 * s-b: a comment that fails on "Task not found" while the reply says done; the person objects.
 * s-c: no turn scope and no message: three searches that list nothing, and no call.
 * s-d: one clean request, nothing after it.
 */
function fixtures() {
  const a1 = fresh({ session: "s-a", turnId: "a1", traceId: "tr-a1", start: BASE })
    .invoke("find_task")
    .invoke("update_task");
  const a2 = fresh({ after: a1, turnId: "a2", traceId: "tr-a2", gapMs: 120_000 }).invoke(
    "update_task",
  );
  const b1 = fresh({ session: "s-b", turnId: "b1", traceId: "tr-b1", start: BASE + 600_000 })
    .invoke("add_task_comment")
    .error("add_task_comment");
  const c1 = fresh({ session: "s-c", start: BASE + 1_200_000 })
    .search([], { query: "export project to csv" })
    .search([], { query: "csv export of all tasks" })
    .search([], { query: "download project data" });
  const d1 = fresh({
    session: "s-d",
    turnId: "d1",
    traceId: "tr-d1",
    start: BASE + 1_800_000,
  }).invoke("create_task");
  return [a1, a2, b1, c1, d1];
}

const SAID: Said[] = [
  {
    session: "s-a",
    turnId: "a1",
    at: BASE - 2_000,
    text: "close the onboarding task",
    reply: "Marked ONB-3 as Done.",
  },
  {
    session: "s-a",
    turnId: "a2",
    at: BASE + 120_000,
    text: "now close ONB-4 too",
    reply: "Closed ONB-4.",
  },
  {
    session: "s-a",
    turnId: "a3",
    at: BASE + 300_000,
    text: "ok good, thanks",
    reply: "You're welcome.",
  },
  {
    session: "s-b",
    turnId: "b1",
    at: BASE + 598_000,
    text: "add a comment on RS-202 that the fix shipped",
    reply: "Done. The comment is on RS-202.",
  },
  { session: "s-b", turnId: "b2", at: BASE + 700_000, text: "the comment is not there" },
  {
    session: "s-d",
    turnId: "d1",
    at: BASE + 1_798_000,
    text: "create a task to renew the SSL cert",
    reply: "Created OPS-12.",
  },
];

async function seeded(): Promise<{ client: PGlite; db: Db }> {
  const { client, db } = await setupDb();
  await seedLedger(client, db, fixtures());
  await client.query(
    `update trace_events set error_message = 'Task "RS-202" not found' where type = 'invoke_error'`,
  );
  for (const said of SAID) {
    const at = new Date(said.at).toISOString();
    const trace = `tr-${said.turnId}`;
    await client.query(
      `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, client_event_id, trace_id, turn_id, payload)
       values ($1::uuid, $2::uuid, 'turn_start', $3, $4::timestamptz, $4::timestamptz, $8::text, $5, $6::text, jsonb_build_object('user_message', $7::text, 'turn_id', $6::text))`,
      [randomUUID(), PROJECT_ID, said.session, at, trace, said.turnId, said.text, randomUUID()],
    );
    if (!said.reply) continue;
    const output = JSON.stringify([
      { role: "assistant", parts: [{ type: "text", content: said.reply }], finish_reason: "stop" },
    ]);
    await client.query(
      `insert into otel_spans (id, project_id, trace_id, span_id, name, kind, span_class, started_at, ended_at, duration_ms, status_code, attributes)
       values ($1::uuid, $2::uuid, $3, $4, 'chat model', 3, 'llm', $5::timestamptz, $5::timestamptz, 900, 0, jsonb_build_object('gen_ai.output.messages', $6::text))`,
      [randomUUID(), PROJECT_ID, trace, randomUUID().replaceAll("-", "").slice(0, 16), at, output],
    );
  }
  return { client, db };
}

/** A fake Sage: answers from the content alone, and records what it was sent. */
function fakeSage() {
  const sent: ClosedQuestionRequest[][] = [];
  const answer = (content: string, id: string): string => {
    const objects = content.includes("The person then said: the comment is not there");
    if (id === "satisfied") return objects ? "no" : "yes";
    if (id === "reaction")
      return objects
        ? "corrects"
        : content.includes("The person then said: now close")
          ? "new_request"
          : "satisfied";
    if (id === "misunderstood") return "no";
    if (id === "completed") return content.includes("(error:") ? "no" : "yes";
    if (id === "asks") return "yes";
    if (id === "claims") return "yes";
    if (id === "search_run") return "one_need";
    if (id === "task_done") return content.includes("(error:") ? "partly" : "achieved";
    return "none";
  };
  const client: ClosedQuestionClient = {
    model: SAGE2_MODEL,
    decide: async () => {
      throw new Error("not used");
    },
    decideBatch: async (requests) => {
      sent.push([...requests]);
      return {
        answers: requests.map((request) =>
          request.questions.map((question) => ({
            id: question.id,
            answer: answer(request.content, question.id),
            probability: 0.9,
            reasoned: false,
          })),
        ),
        inputTokens: requests.reduce((total, request) => total + request.questions.length * 40, 0),
        outputTokens: 0,
      };
    },
  };
  const questions = () =>
    sent.flatMap((requests) =>
      requests.flatMap((request) => request.questions.map((question) => question.id)),
    );
  return { client, sent, questions };
}

interface RunOptions {
  /** The organization's Sentiment analysis flag; on unless said. */
  switchOn?: boolean;
  /** Counts every read of captured text. */
  loads?: { text: number; flag: number };
}

/**
 * One signal run through the reading's own wiring (`outcomeRunDeps`): the
 * model layer bound to the test database, a fake client (null: no key) and
 * the switch.
 */
async function run(
  db: Db,
  client: ClosedQuestionClient | null,
  at: Date,
  ask: Partial<AskDeps> = {},
  options: RunOptions = {},
): Promise<StoredOutcomes> {
  const loaded = () => {
    if (options.loads) options.loads.text += 1;
  };
  const model = (): ModelReadDeps => ({
    ask: {
      client,
      loadVerdicts: (id, keys) => loadOutcomeVerdicts(id, keys, db),
      saveVerdicts: (id, sage, rows) => saveOutcomeVerdicts(id, sage, rows, db),
      maxAsks: 100,
      maxTokens: 100_000,
      reasoning: "off",
      ...ask,
    },
    loadMessages: (id, sessionIds, range) => (
      loaded(), loadSessionMessages(id, sessionIds, range, db)
    ),
    loadReplies: (id, traceIds) => (loaded(), loadReplies(id, traceIds, db)),
    loadQueries: (id, eventIds) => (loaded(), loadSearchQueries(id, eventIds, db)),
  });
  const questionsSwitch = async () => {
    if (options.loads) options.loads.flag += 1;
    return options.switchOn ?? true;
  };
  await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    {
      ...jobDeps(db, at),
      recordOutcomes: (projectId, input, budget) => {
        const wired = outcomeRunDeps(budget, model, questionsSwitch);
        return recordOutcomes(projectId, input, {
          ...wired,
          listPage: (p, range, _db, limit) => listClosedTurnsPage(p, range, db, limit),
          loadBasis: async (p, w) => chooseRunBasis(await loadRunBasisCounts(p, w, db)),
          loadErrors: (p, ids) => loadErrorMessages(p, ids, db),
          loadSearchQueries: (p, ids) => loadSearchQueries(p, ids, db),
          loadLastCalls: (p, ids) => loadLastCalls(p, ids, db),
          replaceTurnRows: (p, range, rows, when) => replaceTurnOutcomes(p, range, rows, when, db),
          loadSessionTurns: (p, ids) => loadSessionTurns(p, ids, db),
          replaceSessionRows: (p, ids, rows, when) =>
            replaceSessionOutcomes(p, ids, rows, when, db),
          loadTaskVerdicts: (p, ids) => loadTaskVerdicts(p, ids, db),
          replaceTaskRows: (p, ids, rows, when) => replaceTaskOutcomes(p, ids, rows, when, db),
          loadReplyTexts: (p, turns) => loadTurnReplies(p, turns, db),
          loadNextScopeReplies: (p, turns) => loadNextScopeReplies(p, turns, db),
          writeReplyReactions: (p, rows) => writeReplyReactions(p, rows, db),
          // The answers' writer goes to the test database, where the wiring put one.
          ...(wired.writeTurnAnswers
            ? {
                writeTurnAnswers: (p: string, rows: readonly TurnAnswerRow[]) =>
                  writeTurnAnswers(p, rows, db),
              }
            : {}),
          writeTurnResults: (p, rows) => writeTurnResults(p, rows, db),
        });
      },
    },
  );
  const stored = (await latestSignalRun(PROJECT_ID, db))?.summary as
    | { outcomes?: StoredOutcomes }
    | undefined;
  assert.ok(stored?.outcomes);
  return stored.outcomes;
}

interface ModelRow {
  key: string;
  satisfaction: string | null;
  reaction: string | null;
  claimed_done: boolean | null;
  request: boolean | null;
  cause: string | null;
  cause_source: string | null;
  model_version: number | null;
}

async function modelRows(client: PGlite): Promise<Map<string, Omit<ModelRow, "key">>> {
  const result = await client.query<ModelRow>(
    `select t.turn_key as key, o.satisfaction, o.reaction, o.claimed_done, o.request, o.cause, o.cause_source, o.model_version
     from trace_turn_outcomes o join trace_turns t on t.id = o.turn_id where o.project_id = '${PROJECT_ID}'`,
  );
  return new Map(
    result.rows.map(({ key, ...row }) => [
      key.startsWith("declared:") ? key.slice("declared:".length) : "inferred",
      row,
    ]),
  );
}

const NONE = {
  satisfaction: null,
  reaction: null,
  claimed_done: null,
  request: null,
  model_version: null,
};

test("without a key the reading makes no call and writes rule-only rows", async () => {
  const { client, db } = await seeded();
  const loads = { text: 0, flag: 0 };
  const stored = await run(db, null, NOW, {}, { loads });
  assert.equal(stored.turns, 5);
  assert.equal(stored.questions, undefined);
  // The summary says why, and with no key neither the flag nor any text is read.
  assert.equal(stored.questionsOff, "no_key");
  assert.deepEqual(loads, { text: 0, flag: 0 });
  const rows = await modelRows(client);
  assert.equal(rows.size, 5);
  assert.deepEqual(rows.get("a1"), { ...NONE, cause: null, cause_source: null });
  assert.deepEqual(rows.get("b1"), { ...NONE, cause: "wrong_reference", cause_source: "rule" });
  assert.deepEqual(rows.get("inferred"), { ...NONE, cause: null, cause_source: null });
  assert.equal(await count(client, `select count(*)::int as n from trace_workflow_verdicts`), 0);
  await client.close();
});

test("with a key the answers land on the rows as closed values, under the cap", async () => {
  const { client, db } = await seeded();
  const sage = fakeSage();
  const stored = await run(db, sage.client, NOW);

  const questions = stored.questions!;
  assert.equal(stored.questionsOff, undefined);
  assert.equal(questions.turnsWithText, 4);
  assert.equal(questions.turnsAnswered, 5);
  assert.equal(questions.fresh, sage.questions().length);
  assert.ok(questions.fresh > 0 && questions.fresh <= 100);
  assert.deepEqual(
    [questions.cached, questions.capped, questions.failed, questions.stopped],
    [0, 0, 0, null],
  );
  // a1 and a2 and b1 have a next message (3 + 2 questions each), b1 a failed call and a reply (the claim), d1 its own work (2), s-c its search run.
  // Then one task question per task with a goal in words: a1, a2, b1 and d1 by their requests, s-c by its searches.
  assert.deepEqual(
    sage.questions().sort(),
    [
      ...Array(4).fill("asks"),
      "claims",
      ...Array(4).fill("completed"),
      ...Array(3).fill("misunderstood"),
      ...Array(3).fill("reaction"),
      ...Array(3).fill("satisfied"),
      "search_run",
      ...Array(5).fill("task_done"),
    ].sort(),
  );
  assert.equal(questions.tasksAsked, 5);
  const tasks = await client.query<{ answer: string | null; tier: string; goal_source: string }>(
    `select answer, tier, goal_source from trace_task_outcomes order by goal_source, tier`,
  );
  assert.deepEqual(
    tasks.rows.map((row) => [row.goal_source, row.answer]),
    [
      ["request", "achieved"],
      ["request", "achieved"],
      ["request", "achieved"],
      ["request", "partly"],
      ["search", "achieved"],
    ],
  );

  const rows = await modelRows(client);
  // A plain new request after the turn is neutral, not satisfied.
  assert.deepEqual(rows.get("a1"), {
    satisfaction: "neutral",
    reaction: "new_request",
    claimed_done: null,
    request: true,
    cause: null,
    cause_source: null,
    model_version: 1,
  });
  // The thanks ran no call and has no turn of its own; it is what the person said after a2.
  assert.deepEqual(rows.get("a2"), {
    satisfaction: "satisfied",
    reaction: "satisfied",
    claimed_done: null,
    request: true,
    cause: null,
    cause_source: null,
    model_version: 1,
  });
  // The reply said done over a failed call; the rule's cause stays the rule's.
  assert.deepEqual(rows.get("b1"), {
    satisfaction: "unsatisfied",
    reaction: "corrects",
    claimed_done: true,
    request: true,
    cause: "wrong_reference",
    cause_source: "rule",
    model_version: 1,
  });
  // No next message: nothing about how it was taken.
  assert.deepEqual(rows.get("d1"), {
    satisfaction: null,
    reaction: null,
    claimed_done: null,
    request: true,
    cause: null,
    cause_source: null,
    model_version: 1,
  });
  // No user text: only the search run, read as a tool the catalog lacks.
  assert.deepEqual(rows.get("inferred"), {
    satisfaction: null,
    reaction: null,
    claimed_done: null,
    request: null,
    cause: "missing_capability",
    cause_source: "model",
    model_version: 1,
  });

  // What was sent: the turn's request, its calls with their outcome, the captured reply and the next message.
  const contents = sage.sent.flat().map((request) => request.content);
  assert.ok(
    contents.includes(
      'The person asked: add a comment on RS-202 that the fix shipped\nThe agent did: add_task_comment (error: Task "RS-202" not found)\nThe agent replied: Done. The comment is on RS-202.\nThe person then said: the comment is not there',
    ),
  );
  assert.ok(
    contents.includes(
      "1. export project to csv\n2. csv export of all tasks\n3. download project data",
    ),
  );

  // No message, reply or query reaches the rows or the cache.
  for (const table of [
    "trace_turn_outcomes",
    "trace_session_outcomes",
    "trace_workflow_verdicts",
  ]) {
    for (const text of ["onboarding", "not there", "RS-202", "csv"]) {
      assert.equal(
        await count(
          client,
          `select count(*)::int as n from ${table} t where to_jsonb(t)::text ilike '%${text}%'`,
        ),
        0,
        `${table} holds "${text}"`,
      );
    }
  }
  await client.close();
});

test("the fusion writes each turn's result and each session's outcome, from the trace and the answers", async () => {
  const { client, db } = await seeded();
  const stored = await run(db, fakeSage().client, NOW);
  const turns = await client.query<{
    key: string;
    result: string | null;
    result_source: string | null;
    claimed_done: boolean | null;
  }>(
    `select t.turn_key as key, o.result, o.result_source, o.claimed_done from trace_turn_outcomes o join trace_turns t on t.id = o.turn_id order by o.started_at`,
  );
  const byTurn = new Map(
    turns.rows.map((row) => [
      row.key.replace(/^declared:/, "").replace(/^inferred:.*/, "inferred"),
      [row.result, row.result_source, row.claimed_done],
    ]),
  );
  assert.deepEqual(byTurn.get("a1"), ["completed", "model", null]);
  assert.deepEqual(byTurn.get("a2"), ["completed", "model", null]);
  // The reply said done over a failed call: a false completion, and the turn failed.
  assert.deepEqual(byTurn.get("b1"), ["failed", "model", true]);
  assert.deepEqual(byTurn.get("d1"), ["completed", "model", null]);
  // No user text: the trace alone decides, and says so.
  assert.deepEqual(byTurn.get("inferred"), ["failed", "rule", null]);

  const sessions = await client.query<{
    session_id: string;
    outcome: string;
    outcome_source: string;
  }>(`select session_id, outcome, outcome_source from trace_session_outcomes order by session_id`);
  assert.deepEqual(sessions.rows, [
    { session_id: "s-a", outcome: "resolved_clean", outcome_source: "model" },
    { session_id: "s-b", outcome: "gave_up", outcome_source: "model" },
    { session_id: "s-c", outcome: "blocked", outcome_source: "rule" },
    { session_id: "s-d", outcome: "resolved_clean", outcome_source: "model" },
  ]);
  assert.deepEqual(stored.fusion, {
    results: { completed: 3, completed_wrong: 0, failed: 2, refused: 0 },
    falseCompletions: 1,
    sessions: {
      resolved_clean: 2,
      resolved_after_friction: 0,
      gave_up: 1,
      blocked: 1,
      escalated: 0,
    },
    ruleOnlySessions: 1,
  });

  // Without a key the same window is read from the trace alone, and every row says so.
  const bare = await seeded();
  const ruleOnly = await run(bare.db, null, NOW);
  assert.equal(ruleOnly.fusion.ruleOnlySessions, 4);
  assert.equal(
    await count(
      bare.client,
      `select count(*)::int as n from trace_session_outcomes where outcome_source <> 'rule' or outcome = 'escalated'`,
    ),
    0,
  );
  assert.equal(
    await count(
      bare.client,
      `select count(*)::int as n from trace_turn_outcomes where result_source = 'model'`,
    ),
    0,
  );
  await bare.client.close();
  await client.close();
});

test("a configured key with the switch off makes 0 calls, loads no text and writes only rule rows", async () => {
  const { client, db } = await seeded();
  const sage = fakeSage();
  const loads = { text: 0, flag: 0 };
  const stored = await run(db, sage.client, NOW, {}, { switchOn: false, loads });

  // The flag was asked once, and that was all: no text read, nothing sent.
  assert.deepEqual(loads, { text: 0, flag: 1 });
  assert.equal(sage.sent.length, 0);
  assert.equal(stored.questions, undefined);
  assert.equal(stored.questionsOff, "switch_off");
  assert.equal(stored.turns, 5);

  // Every row is the rules' alone: no answer, no model's cause, and results and outcomes marked 'rule'.
  const rows = await modelRows(client);
  assert.equal(rows.size, 5);
  for (const row of rows.values())
    assert.deepEqual(
      { ...row, cause: null, cause_source: null },
      { ...NONE, cause: null, cause_source: null },
    );
  assert.equal(
    await count(
      client,
      `select count(*)::int as n from trace_turn_outcomes where result_source is distinct from 'rule' or cause_source = 'model'`,
    ),
    0,
  );
  assert.equal(
    await count(
      client,
      `select count(*)::int as n from trace_session_outcomes where outcome_source is distinct from 'rule'`,
    ),
    0,
  );
  assert.equal(await count(client, `select count(*)::int as n from trace_workflow_verdicts`), 0);
  assert.equal(stored.fusion.ruleOnlySessions, 4);
  await client.close();
});

test("a key and the switch on asks the questions; turning the switch off later stops the asking and keeps the answers", async () => {
  const { client, db } = await seeded();
  const sage = fakeSage();
  const loads = { text: 0, flag: 0 };
  const on = await run(db, sage.client, NOW, {}, { switchOn: true, loads });
  assert.equal(loads.flag, 1);
  assert.ok(loads.text > 0);
  assert.equal(on.questionsOff, undefined);
  assert.equal(on.questions!.fresh, sage.questions().length);
  assert.ok(on.questions!.fresh > 0);
  const before = await modelRows(client);
  assert.equal(before.get("b1")?.satisfaction, "unsatisfied");

  const text = loads.text;
  const calls = sage.sent.length;
  const off = await run(
    db,
    sage.client,
    new Date(NOW.getTime() + 60_000),
    {},
    { switchOn: false, loads },
  );
  assert.equal(off.questionsOff, "switch_off");
  assert.deepEqual([loads.text, sage.sent.length], [text, calls]);
  assert.deepEqual(await modelRows(client), before);
  await client.close();
});

test("a cap of zero is its own reason, and the flag is not asked", async () => {
  const { client, db } = await seeded();
  const sage = fakeSage();
  const loads = { text: 0, flag: 0 };
  const stored = await run(db, sage.client, NOW, { maxAsks: 0 }, { loads });
  assert.equal(stored.questionsOff, "cap_zero");
  assert.deepEqual([loads.text, loads.flag, sage.sent.length], [0, 0, 0]);
  await client.close();
});

test("a second run of the same window makes 0 fresh calls and keeps the rows", async () => {
  const { client, db } = await seeded();
  const sage = fakeSage();
  const first = await run(db, sage.client, NOW);
  const before = await modelRows(client);
  const calls = sage.sent.length;

  const second = await run(db, sage.client, new Date(NOW.getTime() + 60_000));
  assert.equal(sage.sent.length, calls);
  assert.deepEqual(
    [second.questions!.fresh, second.questions!.calls, second.questions!.cached],
    [0, 0, first.questions!.fresh],
  );
  assert.deepEqual(await modelRows(client), before);

  // A later run without a key reads the rules again and leaves the answers where they are.
  const off = await run(db, null, new Date(NOW.getTime() + 120_000));
  assert.equal(off.questions, undefined);
  assert.deepEqual(await modelRows(client), before);
  await client.close();
});

test("fresh questions stay under the per-run cap; the next run asks what was left", async () => {
  const { client, db } = await seeded();
  const sage = fakeSage();
  const first = await run(db, sage.client, NOW, { maxAsks: 6 });
  assert.equal(first.questions!.fresh, 6);
  assert.equal(sage.questions().length, 6);
  // Every question the cap kept back waits: the turns' questions and the task questions.
  assert.equal(first.questions!.capped, 15);

  const second = await run(db, sage.client, new Date(NOW.getTime() + 60_000), { maxAsks: 6 });
  assert.deepEqual(
    [second.questions!.cached, second.questions!.fresh, second.questions!.capped],
    [6, 6, 10],
  );
  assert.equal(sage.questions().length, 12);
  await client.close();
});

test("a model layer that fails leaves the rule rows and the summary standing", async () => {
  const { client, db } = await seeded();
  const broken: ClosedQuestionClient = {
    model: SAGE2_MODEL,
    decide: async () => {
      throw new Error("not used");
    },
    decideBatch: async () => {
      throw new Error("boom");
    },
  };
  const stored = await run(db, broken, NOW);
  assert.equal(stored.turns, 5);
  assert.equal(stored.questions, undefined);
  assert.equal(stored.questionsOff, "failed");
  assert.equal((await modelRows(client)).get("b1")?.cause, "wrong_reference");
  await client.close();
});
