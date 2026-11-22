import assert from "node:assert/strict";
import { test } from "node:test";
import type { StepReadings } from "./metrics";
import { stepKindTables, stepPresets } from "./tables";

const MODEL = {
  calls: 30,
  runs: 10,
  callsPerRun: 3,
  errors: 3,
  errorRate: 0.1,
  p50Ms: 1200,
  p95Ms: 4100,
  inputTokens: 12_000,
  outputTokens: 1_200,
  reasoningTokens: 0,
  costUsd: 0.4321,
  pricedCalls: 30,
  finish: { length: 2, contentFilter: 0, known: 30 },
  retries: 1,
};
const TOOL = {
  calls: 8,
  errors: 2,
  errorRate: 0.25,
  p95Ms: 300,
  retries: 1,
  switches: 1,
  giveUps: 0,
};

function readings(
  over: Partial<StepReadings["kinds"]> = {},
  tasks: StepReadings["tasks"] = [],
): StepReadings {
  return {
    version: 1,
    runs: 10,
    kinds: {
      model_call: MODEL,
      tool_call: TOOL,
      skill: null,
      code: null,
      handoff: null,
      user_message: null,
      ...over,
    },
    tasks,
  };
}

test("the kinds table lists the preset's kinds that ran, in kind order, with plain numbers", () => {
  const all = stepKindTables(readings(), "all", new Map());
  assert.deepEqual(
    all.kinds.map((row) => row.kind),
    ["model_call", "tool_call"],
  );
  assert.deepEqual(all.kinds[0], {
    kind: "model_call",
    label: "Model calls",
    count: "30",
    perRun: "3",
    failed: "10%",
    slow: "4.1 s",
    retries: "1",
    detail: "12,000 tokens in, 1,200 out · $0.43",
  });
  assert.equal(all.kinds[1]!.detail, "1 switched, 0 gave up");

  const models = stepKindTables(readings(), "models", new Map());
  assert.deepEqual(
    models.kinds.map((row) => row.kind),
    ["model_call"],
  );
  assert.ok(models.model);
  assert.deepEqual(stepKindTables(readings(), "tools", new Map()).model, null);
});

test("the model table reads tokens, cost, latency and how calls stopped", () => {
  const table = stepKindTables(readings(), "models", new Map()).model!;
  assert.deepEqual(
    table.map((row) => [row.label, row.value]),
    [
      ["Input tokens", "12,000"],
      ["Output tokens", "1,200"],
      ["Reasoning tokens", "0"],
      ["Cost", "$0.43"],
      ["Typical time", "1.2 s"],
      ["Time, 95% under", "4.1 s"],
      ["Stopped at the token limit", "2 of 30"],
      ["Blocked by the content filter", "0 of 30"],
    ],
  );
});

test("handoffs, user messages and tasks read in plain words; tasks show by name", () => {
  const table = stepKindTables(
    readings(
      {
        handoff: {
          count: 3,
          errors: 1,
          errorRate: 1 / 3,
          routes: [{ from: null, to: "researcher", count: 3, errors: 1 }],
        },
        user_message: {
          messages: 12,
          segments: 8,
          perSegment: 1.5,
          sentiment: { positive: 2, neutral: 1, negative: 1, read: 4 },
          askedAgain: { runs: 1, read: 8, share: 0.125 },
        },
      },
      [
        {
          workflowId: "w1",
          runs: 8,
          finished: 6,
          finishRate: 0.75,
          costPerRun: 0.05,
          p50DurationMs: 65_000,
          selfCorrectionsPer100: 12.5,
          weakestStep: { kind: "tool_call", name: "lookup", calls: 4, errors: 2, errorRate: 0.5 },
        },
      ],
    ),
    "all",
    new Map([["w1", "Answer a question"]]),
  );

  assert.deepEqual(table.routes, [
    {
      key: JSON.stringify([null, "researcher"]),
      from: "Start of the run",
      to: "researcher",
      count: "3",
      failed: "1 (33%)",
    },
  ]);
  assert.equal(
    table.kinds.find((row) => row.kind === "user_message")!.detail,
    "1.5 per task run · 13% asked again",
  );
  assert.deepEqual(
    table.messages?.map((row) => [row.label, row.value]),
    [
      ["Messages per task run", "1.5"],
      ["Sentiment", "2 positive, 1 neutral, 1 negative"],
      ["Asked again", "1 of 8 (13%)"],
    ],
  );
  assert.deepEqual(table.tasks, [
    {
      id: "w1",
      name: "Answer a question",
      runs: "8",
      finished: "75%",
      costPerRun: "$0.05",
      duration: "1.1 min",
      corrections: "12.5",
      weakest: { kind: "tool_call", name: "lookup", failed: "50%" },
    },
  ]);
  assert.deepEqual(stepKindTables(readings(), "intents", new Map()).tasks, []);
});

test("the presets are links that keep the window", () => {
  const presets = stepPresets("p1", 30);
  assert.deepEqual(
    presets.map((preset) => preset.label),
    ["All", "Tools", "Models", "Intents", "Flow"],
  );
  assert.equal(presets[0]!.href, "/project/p1/health?days=30");
  assert.equal(presets[2]!.href, "/project/p1/health?days=30&steps=models");
  assert.equal(stepPresets("p1", 7)[1]!.href, "/project/p1/health?steps=tools");
});
