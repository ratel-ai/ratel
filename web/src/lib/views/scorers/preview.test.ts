import assert from "node:assert/strict";
import { test } from "node:test";
import { previewScorer } from "./preview";
import { checkDraft, judgeDraft, traceFixture } from "./test-support";

const traces = [
  traceFixture({ traceId: "fast", durationMs: 10 }),
  traceFixture({ traceId: "slow", durationMs: 5000 }),
];

test("a test gives one result per newest matching trace, whatever the sample rate", async () => {
  const asked: unknown[] = [];
  const deps = {
    latest: async (...args: unknown[]) => {
      asked.push(args.slice(0, 3));
      return traces;
    },
    count: async () => 0,
    preset: async () => [],
    judge: async () => [
      { status: "scored" as const, score: { value: 1, passed: true, confidence: 0.9 } },
      { status: "skipped" as const, reason: "no_content" as const },
    ],
  };
  const check = checkDraft({ sampleRate: 1, filter: { models: ["a"] } });
  const results = await previewScorer("p", check, deps);
  assert.deepEqual(asked, [["p", check, 5]]);
  assert.deepEqual(
    results.map(({ traceId, outcome }) => [
      traceId,
      outcome.status === "scored" && outcome.score.passed,
    ]),
    [
      ["fast", true],
      ["slow", false],
    ],
  );
  const judged = await previewScorer("p", judgeDraft(), deps);
  assert.deepEqual(
    judged.map((result) => result.outcome.status),
    ["scored", "skipped"],
  );
});
