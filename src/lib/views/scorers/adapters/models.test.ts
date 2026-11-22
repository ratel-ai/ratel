import assert from "node:assert/strict";
import { test } from "node:test";
import type { JudgeEngine } from "@/lib/readings/decisions/judge";
import { decisionPortOf, judgePortOf } from "./models";

const OPTIONS = [
  { id: "yes", label: "Yes" },
  { id: "no", label: "No" },
];

test("judgePortOf reads a pass as 1 and reports the usage", async () => {
  const usage: unknown[] = [];
  const port = judgePortOf(
    {
      model: "m",
      standIn: true,
      judge: async ({ run }) => ({
        pass: run.includes("booked"),
        usage: { inputTokens: 10, outputTokens: 1 },
      }),
    },
    (model, spent) => usage.push([model, spent.inputTokens]),
  );
  assert.equal((await port.judge({ criteria: "c", transcript: "booked" }))?.value, 1);
  assert.equal((await port.judge({ criteria: "c", transcript: "failed" }))?.value, 0);
  assert.deepEqual(usage, [
    ["m", 10],
    ["m", 10],
  ]);
});

test("decisionPortOf asks the engine with the question and the options", async () => {
  let framed = "";
  const engine = (entryId: string): JudgeEngine => ({
    model: "d",
    judge: async (cases, corpus) => {
      assert.equal(cases[0]!.query, "the run");
      assert.deepEqual(
        corpus.map((entry) => entry.entryId),
        ["yes", "no"],
      );
      return [{ id: "run", entryId, confident: true }];
    },
  });
  const port = decisionPortOf((framing) => {
    framed = framing.question;
    return engine("no");
  });
  assert.deepEqual(
    await port.decide({ question: "Booked?", options: OPTIONS, transcript: "the run" }),
    { choice: "no" },
  );
  assert.equal(framed, "Booked?");
  assert.equal(
    await decisionPortOf(() => engine("")).decide({
      question: "Q",
      options: OPTIONS,
      transcript: "the run",
    }),
    null,
  );
  assert.equal(
    await decisionPortOf(() => null).decide({
      question: "Q",
      options: OPTIONS,
      transcript: "the run",
    }),
    null,
  );
});
