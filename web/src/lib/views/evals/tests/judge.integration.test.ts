import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvalJudge, EvalJudgeEvidence } from "@/lib/contracts/eval-judge";
import type { ModelCallRecord } from "@/lib/contracts/telemetry";
import { createDecisionJudge } from "../adapters/decision-judge";
import { createDrizzleJudgeBudget } from "../adapters/drizzle-judge-budget";
import { type JudgeDeps, judgeTrial } from "../judge";
import { createEvalsDb, ORGANIZATION_ID, PROJECT_ID } from "./support";

const SUBJECT = { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID };
const EVIDENCE: EvalJudgeEvidence = {
  question: "Is it polite?",
  input: "hi",
  earlierTurns: [],
  expectedOutput: null,
  output: "hello",
  toolCalls: [],
};

async function setup({
  payer = "ratel",
  budget = 100,
  ask,
}: {
  payer?: EvalJudge["payer"];
  budget?: number | null;
  ask?: EvalJudge["ask"];
} = {}) {
  const { db, client } = await createEvalsDb();
  const asked: unknown[] = [];
  const records: ModelCallRecord[] = [];
  const judge: EvalJudge = {
    provider: "openai",
    model: "m",
    payer,
    usdPerInputToken: 0.01,
    ask: async (request) => {
      asked.push(request);
      return ask
        ? ask(request)
        : { answer: { choice: request.options[0]?.id ?? "", confidence: 1 }, inputTokens: 50 };
    },
  };
  const deps: JudgeDeps = {
    judge: { judgeFor: async () => judge },
    limits: { dailyBudgetUsd: async () => budget },
    budget: createDrizzleJudgeBudget(db),
    recordModelCall: (record) => void records.push(record),
    now: () => new Date("2026-11-25T23:00:00Z"),
  };
  const spent = async () =>
    (
      await client.query<{ usd: number; day: string }>(
        "select usd, day::text from eval_judge_spend",
      )
    ).rows;
  return { deps, asked, records, spent };
}

test("the answer settles the real cost of the day", async () => {
  const t = await setup();
  const outcome = await judgeTrial(SUBJECT, EVIDENCE, t.deps);
  assert.ok(outcome.status === "answered" && outcome.passed && outcome.reason.startsWith("Yes"));
  assert.deepEqual(await t.spent(), [{ usd: 1, day: "2026-11-25" }]);
});

test("a spent budget refuses with no call, with its outcome and reason", async () => {
  const t = await setup({ budget: 100 });
  await t.deps.budget.hold(ORGANIZATION_ID, "2026-11-25", 100, 100);
  const outcome = await judgeTrial(SUBJECT, EVIDENCE, t.deps);
  assert.deepEqual(outcome, {
    status: "not_scored",
    code: "refused_budget",
    reason: "The judge budget of this organization for today (100 USD) is used.",
  });
  assert.equal(t.asked.length, 0);
  assert.deepEqual(
    t.records.map(({ outcome: o, feature, payer }) => [o, feature, payer]),
    [["refused_budget", "evals_judge", "ratel"]],
  );
  t.deps.now = () => new Date("2026-11-26T00:00:00Z");
  assert.equal((await judgeTrial(SUBJECT, EVIDENCE, t.deps)).status, "answered");
});

test("two holds at the same time do not pass the budget together", async () => {
  const { deps } = await setup();
  const day = "2026-11-25";
  const held = await Promise.all(
    [1, 2, 3].map(() => deps.budget.hold(ORGANIZATION_ID, day, 40, 100)),
  );
  assert.deepEqual(held.filter(Boolean).length, 2);
});

test("with the customer's key or with no budget, no budget check runs", async () => {
  for (const options of [{ payer: "customer", budget: 0 } as const, { budget: null }]) {
    const t = await setup(options);
    assert.equal((await judgeTrial(SUBJECT, EVIDENCE, t.deps)).status, "answered");
    assert.deepEqual(await t.spent(), []);
  }
});

test("a failed call is an outcome, and its hold stays", async () => {
  const t = await setup({
    ask: async () => {
      throw new Error("secret text");
    },
  });
  const outcome = await judgeTrial(SUBJECT, EVIDENCE, t.deps);
  assert.ok(outcome.status === "not_scored" && outcome.code === "call_failed");
  assert.ok(((await t.spent())[0]?.usd ?? 0) > 0);
});

test("a refused question is no answer", async () => {
  const t = await setup({ ask: async () => ({ answer: null, inputTokens: 10 }) });
  const outcome = await judgeTrial(SUBJECT, EVIDENCE, t.deps);
  assert.ok(outcome.status === "not_scored" && outcome.code === "no_answer");
});

test("with no judge engine configured, no outbound call is made", async () => {
  const t = await setup();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response();
  }) as typeof fetch;
  const outcome = await judgeTrial(SUBJECT, EVIDENCE, {
    ...t.deps,
    judge: createDecisionJudge(() => null, fetchImpl),
  });
  assert.ok(outcome.status === "not_scored" && outcome.code === "not_configured");
  assert.equal(calls, 0);
  assert.deepEqual(await t.spent(), []);
});
