import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { resolveTaskJudge, resolveTestDraftModel } from "@/lib/views/eval-gate/models";
import { draftTestFromRun, TestDraftError } from "@/lib/views/task-evals/run-to-test";
import { judgeTaskSample } from "@/lib/views/task-scorers/judge";

/**
 * With no model key the task loop has no model: the live judge is skipped without a row and
 * nothing calls out, while the deterministic scorers still run (`task-scorers/job.ts`); a
 * simulation reserves nothing and scores deterministically; run-to-test says no model is
 * configured. The stand-ins are a local switch, never a production one. No upstream counterpart (the sibling of
 * `eval-gate/no-outbound-without-key.test.ts`).
 */

const NO_KEYS = { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined };
const saved = { ...process.env };
const realFetch = globalThis.fetch;

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.EVAL_GATE_MOCK_MODEL;
  globalThis.fetch = (() => {
    throw new Error("no request may leave the process without a model key");
  }) as typeof fetch;
});

afterEach(() => {
  process.env = { ...saved };
  globalThis.fetch = realFetch;
});

test("with no key and no mock there is no task judge", () => {
  assert.equal(resolveTaskJudge(NO_KEYS), null);
  assert.equal(resolveTaskJudge({ ANTHROPIC_API_KEY: "REPLACE_ME" }), null, "the placeholder key");
});

test("EVAL_GATE_MOCK_MODEL=1 gives the rule judge outside production", () => {
  const judge = resolveTaskJudge({ ...NO_KEYS, EVAL_GATE_MOCK_MODEL: "1" });
  assert.equal(judge?.standIn, true);
});

test("the live judge with no key reads nothing, writes nothing and calls nothing", async () => {
  // Any use of the database fails the test: with no judge the sample returns before a query.
  const db = new Proxy(
    {},
    {
      get: () => {
        throw new Error("the database was touched");
      },
    },
  ) as never;
  await judgeTaskSample(
    "11111111-1111-4111-8111-111111111111",
    "task-a",
    "Call notify.",
    [],
    new Date("2026-11-01T12:00:00Z"),
    db,
  );
});

test("with no key and no mock there is no test drafter; the stand-in only with the mock", () => {
  assert.equal(resolveTestDraftModel(NO_KEYS), null);
  assert.equal(resolveTestDraftModel({ ANTHROPIC_API_KEY: "REPLACE_ME" }), null);
  assert.equal(resolveTestDraftModel({ ...NO_KEYS, EVAL_GATE_MOCK_MODEL: "1" })?.standIn, true);
});

test("run-to-test with no key refuses before it reserves or calls anything", async () => {
  // The gate is on, the run exists and is not in the set; the missing model is the refusal.
  // Two reads answer (the run, then the eval set); a third read or any write fails the test.
  const answers = [[{ id: "turn" }], []];
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = answers.shift();
          if (!rows) throw new Error("no read may follow the refusal");
          return { limit: async () => rows };
        },
      }),
    }),
  } as never;
  await assert.rejects(
    draftTestFromRun("11111111-1111-4111-8111-111111111111", "task-a", "turn", {
      db,
      flagDeps: { FF_EVAL_GATE: "1" },
      model: null,
    }),
    (err: unknown) => err instanceof TestDraftError && /No model is configured/.test(err.message),
  );
});
