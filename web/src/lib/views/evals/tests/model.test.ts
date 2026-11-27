import assert from "node:assert/strict";
import { test } from "node:test";
import type { Scorer } from "@/lib/views/scorers/types";
import { chooseTurns } from "../domain/choose";
import {
  DEFAULT_ROW_LIMIT,
  datasetSettingsSchema,
  MAX_ROW_LIMIT,
  querySummary,
  tooManyRows,
} from "../domain/dataset";
import { type EvalScorer, evalContentSchema } from "../domain/eval";
import {
  combinationCount,
  combinations,
  MAX_COMBINATIONS,
  matrixProblem,
  matrixSchema,
} from "../domain/matrix";
import {
  EXPECTED_OUTPUT_VALUE,
  PREDEFINED_KEYS,
  PREDEFINED_SCORERS,
  predefinedDefinition,
  trialCheckOfPreset,
} from "../domain/predefined-scorers";
import { scoreTrial, type TrialRecord } from "../domain/score";
import { libraryOf, resolveScorers } from "../domain/scorer-library";

/** The pure parts of the model: dataset settings, the matrix, "let Ratel choose", the library. */

test("each dataset kind has its settings, with a default limit of 50 and a hard limit of 500", () => {
  assert.deepEqual(datasetSettingsSchema.parse({ kind: "fixed" }), { kind: "fixed" });
  assert.deepEqual(datasetSettingsSchema.parse({ kind: "last_traces" }), {
    kind: "last_traces",
    limit: DEFAULT_ROW_LIMIT,
  });
  assert.deepEqual(
    datasetSettingsSchema.parse({ kind: "task_traces", taskId: "wf-1", limit: 10 }),
    {
      kind: "task_traces",
      taskId: "wf-1",
      limit: 10,
    },
  );
  assert.deepEqual(
    datasetSettingsSchema.parse({ kind: "rql", text: "select trace_id from traces" }),
    { kind: "rql", text: "select trace_id from traces", days: 7, limit: 50 },
  );
  assert.deepEqual(datasetSettingsSchema.parse({ kind: "choose" }), {
    kind: "choose",
    taskId: null,
    limit: 50,
  });
  const over = datasetSettingsSchema.safeParse({ kind: "last_traces", limit: MAX_ROW_LIMIT + 1 });
  assert.equal(over.success, false);
  assert.match(over.error?.issues[0]?.message ?? "", /at most 500 rows/);
  assert.equal(datasetSettingsSchema.safeParse({ kind: "task_traces" }).success, false);
  assert.equal(datasetSettingsSchema.safeParse({ kind: "rql", text: " " }).success, false);
  assert.equal(
    datasetSettingsSchema.safeParse({ kind: "rql", text: "x", days: 31 }).success,
    false,
  );
  assert.equal(datasetSettingsSchema.safeParse({ kind: "nope" }).success, false);
  assert.match(tooManyRows(501) ?? "", /gives 501 rows\. A run takes at most 500\./);
  assert.equal(tooManyRows(500), null);
  assert.equal(querySummary({ kind: "fixed" }), null);
  assert.equal(querySummary({ kind: "rql", text: "select 1", days: 7, limit: 5 }), "select 1");
});

test("a matrix has one variant for each combination, at most 12, of declared params only", () => {
  assert.deepEqual(combinations({}), [{}]);
  assert.deepEqual(combinations({ tone: ["dry", "warm"], model: ["a", "b"] }), [
    { model: "a", tone: "dry" },
    { model: "a", tone: "warm" },
    { model: "b", tone: "dry" },
    { model: "b", tone: "warm" },
  ]);
  assert.equal(combinationCount({ a: [1, 2, 3], b: [1, 2, 3, 4] }), 12);
  assert.equal(matrixSchema.safeParse({ a: [1, 2, 3], b: [1, 2, 3, 4] }).success, true);
  const over = matrixSchema.safeParse({ a: [1, 2, 3], b: [1, 2, 3, 4, 5] });
  assert.equal(over.success, false);
  assert.match(over.error?.issues[0]?.message ?? "", /more than 12 combinations/);
  assert.equal(matrixSchema.safeParse({ a: [] }).success, false);
  assert.equal(matrixSchema.safeParse({ a: [1, 1] }).success, false);
  assert.equal(matrixProblem({ tone: ["dry"] }, new Set(["tone"])), null);
  assert.match(
    matrixProblem({ temperature: [0, 1] }, new Set(["tone"])) ?? "",
    /does not declare the param temperature\. Its params are: tone/,
  );
  assert.match(
    matrixProblem({ a: [1, 2, 3, 4, 5], b: [1, 2, 3] }, null) ?? "",
    new RegExp(`at most ${MAX_COMBINATIONS}`),
  );
  assert.deepEqual(evalContentSchema.parse({ matrix: { tone: ["dry", "warm"] } }).matrix, {
    tone: ["dry", "warm"],
  });
});

test("let Ratel choose: failed and low-score turns first, newest first, spread over the tasks", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 27, 10, minute));
  const turns = [
    { turnId: "ok-a-new", taskId: "a", endedAt: at(9), failed: false, score: 1 },
    { turnId: "fail-a-old", taskId: "a", endedAt: at(1), failed: true, score: null },
    { turnId: "fail-a-new", taskId: "a", endedAt: at(8), failed: true, score: null },
    { turnId: "low-b", taskId: "b", endedAt: at(5), failed: false, score: 0.2 },
    { turnId: "ok-b", taskId: "b", endedAt: at(7), failed: false, score: null },
    { turnId: "ok-none", taskId: null, endedAt: at(6), failed: false, score: 0.9 },
  ];
  assert.deepEqual(chooseTurns(turns, 10), [
    "fail-a-new",
    "low-b",
    "fail-a-old",
    "ok-a-new",
    "ok-b",
    "ok-none",
  ]);
  assert.deepEqual(chooseTurns(turns, 2), ["fail-a-new", "low-b"]);
});

const TRIAL: TrialRecord = {
  output: "Your refund is on its way.",
  toolCalls: [{ name: "refund_order", arguments: { id: "A200" } }],
  durationMs: 900,
  costUsd: 0.02,
  inputTokens: 10,
  outputTokens: 20,
};

/** The result of a pre-defined check with this setting on the trial. */
function checkOf(
  key: (typeof PREDEFINED_KEYS)[number],
  value?: string | number,
  expected?: string,
) {
  const made = predefinedDefinition(key, value);
  assert.ok(made.ok, key);
  const scorer = { id: key, name: key, gating: true, definition: made.definition } as EvalScorer;
  return scoreTrial(TRIAL, [scorer], new Map(), expected ?? null).scorers[0]?.status;
}

test("the pre-defined set: under 12 scorers, each a check or a judge with our names", () => {
  assert.ok(PREDEFINED_SCORERS.length < 12);
  assert.deepEqual(
    PREDEFINED_SCORERS.map(({ key }) => key),
    [...PREDEFINED_KEYS],
  );
  for (const scorer of PREDEFINED_SCORERS) {
    assert.ok(["check", "judge"].includes(scorer.kind), scorer.key);
    assert.ok(scorer.name.length > 0 && scorer.description.length > 0, scorer.key);
  }
});

test("Output equals expected compares with the expected output of the row", () => {
  assert.equal(checkOf("output_equals_expected", undefined, "Your refund is on its way."), "pass");
  assert.equal(checkOf("output_equals_expected", undefined, "No refund."), "fail");
  assert.equal(checkOf("output_equals_expected"), "not_scored");
  const made = predefinedDefinition("output_equals_expected", undefined);
  assert.ok(made.ok && made.definition.kind === "check");
  assert.equal(made.ok && made.definition.config.value, EXPECTED_OUTPUT_VALUE);
});

test("Output contains needs a text", () => {
  assert.equal(checkOf("output_contains", "refund"), "pass");
  assert.equal(checkOf("output_contains", "voucher"), "fail");
  const none = predefinedDefinition("output_contains", undefined);
  assert.ok(!none.ok);
  assert.match(none.ok ? "" : none.message, /Give the scorer "Output contains" a text/);
});

test("Tool was called and Tool was not called need a tool name", () => {
  assert.equal(checkOf("tool_called", "refund_order"), "pass");
  assert.equal(checkOf("tool_called", "cancel_order"), "fail");
  assert.equal(checkOf("tool_not_called", "cancel_order"), "pass");
  assert.equal(checkOf("tool_not_called", "refund_order"), "fail");
  assert.ok(!predefinedDefinition("tool_called", undefined).ok);
});

test("Cost under a limit and Latency under a limit are the presets of tasks, as trial checks", () => {
  assert.equal(checkOf("cost_under", 0.05), "pass");
  assert.equal(checkOf("cost_under", 0.01), "fail");
  assert.equal(checkOf("latency_under", 1000), "pass");
  assert.equal(checkOf("latency_under", 500), "fail");
  assert.ok(!predefinedDefinition("cost_under", "cheap").ok);
  assert.deepEqual(trialCheckOfPreset({ preset: "max_cost_usd", max: 0.05 }), {
    path: "cost_usd",
    op: "lte",
    value: 0.05,
  });
  assert.equal(trialCheckOfPreset({ preset: "ends_well" }), null);
});

test("the judges answer yes or no", () => {
  for (const key of [
    "answer_matches_expected",
    "follows_instructions",
    "answer_is_safe",
  ] as const) {
    const made = predefinedDefinition(key, undefined);
    assert.ok(made.ok && made.definition.kind === "judge", key);
    assert.equal(
      made.ok && made.definition.kind === "judge" && made.definition.config.output,
      "boolean",
    );
  }
});

function projectScorer(over: Partial<Scorer>): Scorer {
  return {
    id: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    projectId: "p",
    name: "Fast",
    kind: "check",
    config: { path: "duration_ms", op: "lt", value: 2000 },
    filter: {} as Scorer["filter"],
    tasks: null,
    sampleRate: 100,
    enabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  } as Scorer;
}

test("the library lists the project's scorers, the pre-defined set and each eval's own, with what a trial can run", () => {
  const fast = projectScorer({});
  const traceOnly = projectScorer({
    id: "22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Prod only",
    config: { path: "environment", op: "eq", value: "prod" },
  });
  const graded = projectScorer({
    id: "33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Tone 1-5",
    kind: "judge",
    config: { prompt: "tone?", output: "numeric" },
  });
  const own = {
    id: "own-1",
    name: "No refund",
    gating: true,
    definition: {
      kind: "check" as const,
      config: { path: "tools", op: "ne" as const, value: "refund_order" },
    },
  };
  const library = libraryOf(
    [fast, traceOnly, graded],
    [{ id: "e1", name: "Refunds", scorers: [own] }],
  );
  assert.deepEqual(
    library.map(({ source, name, usable }) => [source, name, usable]),
    [
      ["project", "Fast", true],
      ["project", "Prod only", false],
      ["project", "Tone 1-5", false],
      ...PREDEFINED_SCORERS.map(({ name }) => ["predefined", name, true]),
      ["eval", "No refund", true],
    ],
  );
  assert.match(library[1]?.reason ?? "", /An eval trial has no environment/);
  assert.equal(library.at(-1)?.evalName, "Refunds");
});

test("a run resolves the references to the scorers that it freezes, or says why it cannot", () => {
  const fast = projectScorer({});
  const resolved = resolveScorers(
    [
      { source: "project", scorerId: fast.id, gating: true },
      { source: "predefined", key: "output_contains", gating: false, value: "refund" },
    ],
    [fast],
  );
  assert.ok(resolved.ok);
  assert.deepEqual(
    resolved.ok && resolved.scorers.map(({ id, name, gating }) => [id, name, gating]),
    [
      [`project:${fast.id}`, "Fast", true],
      ["predefined:output_contains:refund", "Output contains: refund", false],
    ],
  );
  const gone = resolveScorers([{ source: "project", scorerId: fast.id, gating: true }], []);
  assert.deepEqual(gone.ok ? null : gone.reason, "scorer_not_found");
  const traceOnly = projectScorer({ config: { path: "environment", op: "eq", value: "prod" } });
  const unusable = resolveScorers(
    [{ source: "project", scorerId: fast.id, gating: true }],
    [traceOnly],
  );
  assert.deepEqual(unusable.ok ? null : unusable.reason, "scorer_not_usable");
});
