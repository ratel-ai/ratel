import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { organizationModelSpendSince } from "@/lib/views/eval-gate/store";
import {
  JUDGE_TEXT_CHARS,
  type JudgeEngine,
  type JudgeQuestion,
  judgeQuestion,
  judgeTraces,
} from "./judge";
import { createScorer, latestScores } from "./store";
import { sweepScorers } from "./sweep";
import { checkDraft, judgeDraft, traceFixture } from "./test-support";
import type { JudgeConfig } from "./types";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-20T12:00:00Z");
const boolean: JudgeConfig = { prompt: "Is it polite?", output: "boolean" };
const numeric: JudgeConfig = { prompt: "How good is it?", output: "numeric" };
const loadConversation = async () => ({ input: "Hi", output: "Hello" });

test("a boolean maps to pass or fail, a number to 1 to 5, with the confidence", async () => {
  const { client, db } = await setup();
  try {
    const judge = async (config: JudgeConfig, choice: string) =>
      (
        await judgeTraces(
          PROJECT,
          config,
          [traceFixture()],
          { engine: fakeEngine(choice).engine, loadConversation },
          db,
        )
      )[0];
    const scored = (value: number, passed: boolean | null) => ({
      status: "scored",
      score: { value, passed, confidence: 0.8 },
    });
    assert.deepEqual(await judge(boolean, "pass"), scored(1, true));
    assert.deepEqual(await judge(boolean, "fail"), scored(0, false));
    for (const value of [1, 2, 3, 4, 5])
      assert.deepEqual(await judge(numeric, String(value)), scored(value, null));
    for (const [config, choice] of [
      [boolean, "5"],
      [numeric, "6"],
      [numeric, "refused"],
    ] as const)
      assert.deepEqual(await judge(config, choice), { status: "skipped", reason: "no_answer" });
  } finally {
    await client.close();
  }
});

test("long input and output are cut to the limit, and the question carries both", () => {
  const question = judgeQuestion(boolean, {
    input: "i".repeat(JUDGE_TEXT_CHARS + 5000),
    output: "o".repeat(JUDGE_TEXT_CHARS + 5000),
  });
  assert.equal(question.input.match(/i{100,}/)?.[0].length, JUDGE_TEXT_CHARS);
  assert.equal(question.input.match(/o{100,}/)?.[0].length, JUDGE_TEXT_CHARS);
  assert.match(question.instructions, /Is it polite\?/);
  assert.deepEqual(
    judgeQuestion(numeric, { input: "", output: "x" }).options.map((option) => option.id),
    ["1", "2", "3", "4", "5"],
  );
});

test("without an engine, without content, or with the budget spent, no call is made", async () => {
  const { client, db } = await setup();
  try {
    const { engine, questions } = fakeEngine("pass");
    const run = (deps: Parameters<typeof judgeTraces>[3]) =>
      judgeTraces(PROJECT, boolean, [traceFixture()], { engine, loadConversation, ...deps }, db);
    assert.deepEqual(await run({ engine: null }), [{ status: "skipped", reason: "no_engine" }]);
    assert.deepEqual(await run({ loadConversation: async () => null }), [
      { status: "skipped", reason: "no_content" },
    ]);
    assert.deepEqual(await run({ dailyBudgetUsd: 0 }), [
      { status: "skipped", reason: "budget_spent" },
    ]);
    await client.exec(
      `insert into scorer_judge_spend (project_id, day, usd) values ('${PROJECT}', current_date, 10)`,
    );
    assert.deepEqual(await run({}), [{ status: "skipped", reason: "budget_spent" }]);
    assert.equal(questions.length, 0);
  } finally {
    await client.close();
  }
});

test("what the calls used is charged to the daily budget; a failed call keeps its hold", async () => {
  const { client, db } = await setup();
  const spent = () =>
    organizationModelSpendSince(PROJECT, new Date(NOW.getTime() - 86_400_000), db);
  try {
    const deps = { loadConversation, now: () => NOW };
    const traces = [traceFixture({ traceId: "a" }), traceFixture({ traceId: "b" })];
    await judgeTraces(PROJECT, boolean, traces, { ...deps, engine: fakeEngine("pass").engine }, db);
    const used = await spent();
    assert.ok(Math.abs(used - 2 * 1000 * 0.000001) < 1e-9, String(used));

    const broken = fakeEngine("pass");
    broken.engine.ask = async () => {
      throw new Error("down");
    };
    const outcomes = await judgeTraces(PROJECT, boolean, traces, { ...deps, ...broken }, db);
    assert.ok(outcomes.every((outcome) => outcome.status === "skipped"));
    assert.ok((await spent()) > used * 2);
  } finally {
    await client.close();
  }
});

test("a budget with room for one call judges one trace and skips the other", async () => {
  const { client, db } = await setup();
  try {
    const { engine, questions } = fakeEngine("pass");
    const oneCall = (600 + Math.ceil((boolean.prompt.length + 2 * JUDGE_TEXT_CHARS) / 2)) * 1e-6;
    engine.ask = ((ask) => async (question: JudgeQuestion) => ({
      ...(await ask(question)),
      inputTokens: 8_000,
    }))(engine.ask);
    const outcomes = await judgeTraces(
      PROJECT,
      boolean,
      [traceFixture({ traceId: "a" }), traceFixture({ traceId: "b" })],
      { engine, loadConversation, dailyBudgetUsd: oneCall * 1.1, now: () => NOW },
      db,
    );
    assert.equal(questions.length, 1);
    assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["scored", "skipped"]);
  } finally {
    await client.close();
  }
});

test("a sweep judges each trace once, in small batches", async () => {
  const { client, db, judgeId, checkId } = await setupSweep(25);
  try {
    const { engine, questions } = fakeEngine("pass");
    const options = { flagOn: async () => true, judge: { engine, loadConversation } };
    await sweepScorers(options, db);
    const rows = await latestScores(PROJECT, judgeId, 100, db);
    assert.equal(rows.length, 25);
    assert.deepEqual([rows[0]?.passed, rows[0]?.confidence], [true, 0.8]);
    assert.equal((await latestScores(PROJECT, checkId, 100, db)).length, 25);
    await client.exec("update trace_scorers set cursor_at = now() - interval '1 hour'");
    await sweepScorers(options, db);
    assert.equal(questions.length, 25);
  } finally {
    await client.close();
  }
});

test("without an engine, checks still score; with no budget, the skip is reported", async () => {
  const { client, db, judgeId, checkId } = await setupSweep(12);
  try {
    const flagOn = async () => true;
    await sweepScorers({ flagOn, judge: { engine: null, loadConversation } }, db);
    assert.equal((await latestScores(PROJECT, checkId, 100, db)).length, 12);
    assert.equal((await latestScores(PROJECT, judgeId, 100, db)).length, 0);

    await client.exec("update trace_scorers set cursor_at = now() - interval '1 hour'");
    const { engine, questions } = fakeEngine("pass");
    const result = await sweepScorers(
      { flagOn, judge: { engine, loadConversation, dailyBudgetUsd: 0 } },
      db,
    );
    assert.deepEqual(result.budgetSkips, [{ projectId: PROJECT, scorerId: judgeId, traces: 12 }]);
    assert.equal(questions.length, 0);
  } finally {
    await client.close();
  }
});

test("an engine that is down is not asked for the whole backlog in one sweep", async () => {
  const { client, db } = await setupSweep(25);
  try {
    let calls = 0;
    const { engine } = fakeEngine("pass");
    engine.ask = async () => {
      calls += 1;
      throw new Error("down");
    };
    await sweepScorers({ flagOn: async () => true, judge: { engine, loadConversation } }, db);
    assert.equal(calls, 10);
  } finally {
    await client.close();
  }
});

/** Answers every question with `choice` ("refused": a refusal), 1,000 tokens at $1 per million. */
function fakeEngine(choice: string) {
  const questions: JudgeQuestion[] = [];
  const engine: JudgeEngine = {
    model: "fake",
    usdPerInputToken: 0.000001,
    async ask(question) {
      questions.push(question);
      const answer = choice === "refused" ? null : { choice, confidence: 0.8 };
      return { answer, inputTokens: 1000 };
    },
  };
  return { engine, questions };
}

async function setup() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as ReturnType<typeof getDb> };
}

async function setupSweep(traces: number) {
  const { client, db } = await setup();
  const judgeId = await createScorer(PROJECT, judgeDraft(), "u1", db);
  const checkId = await createScorer(PROJECT, checkDraft(), "u1", db);
  await client.exec(`
    update trace_scorers set cursor_at = now() - interval '1 hour', created_at = now() - interval '1 hour';
    insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error,
      input_tokens, output_tokens, cost_usd, spans_max_received_at, updated_at)
    select '${PROJECT}', 't' || n, now(), 500, false, 1, 1, 0, now(), now() - interval '60 seconds'
    from generate_series(1, ${traces}) n;
  `);
  return { client, db, judgeId, checkId };
}
