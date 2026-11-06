import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { resolveTaskJudge } from "@/lib/views/eval-gate/models";
import { judgeTaskSample } from "@/lib/views/task-scorers/judge";

/**
 * With no model key the task loop has no model: the live judge is skipped without a row and
 * nothing calls out, while the deterministic scorers still run (`task-scorers/job.ts`). The
 * stand-ins are a local switch, never a production one. No upstream counterpart (the sibling of
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
