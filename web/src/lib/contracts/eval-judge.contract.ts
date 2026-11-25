import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { askEvalJudge, type EvalJudgeEvidence, type EvalJudgePort } from "./eval-judge";
import type { UsageSubject } from "./usage-limits";

const SUBJECT: UsageSubject = {
  organizationId: "00000000-0000-4000-8000-0000000000a1",
  projectId: "00000000-0000-4000-8000-0000000000b1",
};
const EVIDENCE: EvalJudgeEvidence = {
  question: "Does the answer refuse the refund?",
  input: { message: "refund A200" },
  earlierTurns: [],
  expectedOutput: null,
  output: "I cannot refund it.",
  toolCalls: [{ name: "lookup_order", arguments: { order_id: "A200" }, result: { days: 95 } }],
};

/** The answers of a fake Decisions API, in order. A number is an HTTP status. */
export type FakeAnswers = Array<{ choice: string; confidence: number } | "refusal" | number>;
export type FakeDecisions = { fetchImpl: typeof fetch; bodies: string[]; keys: string[] };

/** What every adapter of the judge must do. Imported by the test of each adapter. */
export function evalJudgeContract(
  label: string,
  make: (fake: FakeDecisions) => EvalJudgePort | Promise<EvalJudgePort>,
): void {
  const ask = async (answers: FakeAnswers) => {
    const fake = fakeDecisions(answers);
    const judge = await (await make(fake)).judgeFor(SUBJECT);
    assert.ok(judge);
    return { fake, judge, verdict: await askEvalJudge(judge, EVIDENCE) };
  };
  describe(`eval judge contract: ${label}`, () => {
    test("it answers yes with a reason, from the output and the tool calls", async () => {
      const { verdict, fake, judge } = await ask([
        { choice: "yes", confidence: 0.934 },
        { choice: "output", confidence: 0.8 },
      ]);
      assert.deepEqual(verdict.answer, {
        passed: true,
        confidence: 0.934,
        reason: "Yes, with a confidence of 93%. The agent's output shows it.",
      });
      assert.equal(verdict.inputTokens, 200);
      assert.ok(judge.usdPerInputToken > 0);
      for (const part of ["refuse the refund?", "I cannot refund it.", "lookup_order", "A200"]) {
        assert.ok(fake.bodies[0]?.includes(part), part);
      }
    });

    test("it answers no with a reason", async () => {
      const { verdict } = await ask([
        { choice: "no", confidence: 0.7 },
        { choice: "tool_call", confidence: 0.8 },
      ]);
      assert.deepEqual(
        [verdict.answer?.passed, verdict.answer?.reason],
        [false, "No, with a confidence of 70%. A tool call of the agent goes against it."],
      );
    });

    test("a refused question has no answer", async () => {
      const { verdict } = await ask(["refusal"]);
      assert.equal(verdict.answer, null);
    });

    test("an answer with a refused reason stays an answer", async () => {
      const { verdict } = await ask([{ choice: "yes", confidence: 1 }, "refusal"]);
      assert.equal(
        verdict.answer?.reason,
        "Yes, with a confidence of 100%. The model chose no reason.",
      );
    });

    test("a failed call is not tried again: the usage of its first try is unknown", async () => {
      const fake = fakeDecisions([500, { choice: "yes", confidence: 1 }]);
      const judge = await (await make(fake)).judgeFor(SUBJECT);
      assert.ok(judge);
      await assert.rejects(askEvalJudge(judge, EVIDENCE));
      assert.equal(fake.bodies.length, 1);
    });

    test("a rejected key throws", async () => {
      await assert.rejects(ask([401]));
    });
  });
}

export function fakeDecisions(answers: FakeAnswers): FakeDecisions {
  const bodies: string[] = [];
  const keys: string[] = [];
  const queue = [...answers];
  const fetchImpl = (async (_url: unknown, init: RequestInit) => {
    bodies.push(String(init.body));
    keys.push(new Headers(init.headers).get("authorization") ?? "");
    const next = queue.shift();
    if (next === undefined) throw new Error("no more answers");
    if (typeof next === "number") return new Response("", { status: next });
    const answer =
      next === "refusal"
        ? { type: "refusal", name: "tool" }
        : { type: "choice", name: "tool", probabilities: [], ...next };
    return Response.json({ answers: [answer], usage: { input_tokens: 100 } });
  }) as typeof fetch;
  return { fetchImpl, bodies, keys };
}
