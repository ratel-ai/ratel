import assert from "node:assert/strict";
import { test } from "node:test";
import { evalScorerSchema } from "../domain/eval";
import {
  buildPredefined,
  PREDEFINED_SCORERS,
  type PredefinedKey,
} from "../domain/predefined-scorers";
import { scoreTrial, type TrialRecord } from "../domain/score";

const TRIAL: TrialRecord = {
  output: { answer: "No refund for A200.", order: "A200" },
  toolCalls: [{ name: "lookup_order", arguments: { id: "A200" } }],
  durationMs: 1_200,
  costUsd: 0.004,
  inputTokens: 100,
  outputTokens: 20,
};

/** The one result of a check scorer of the set on `TRIAL`. */
function checkOn(key: PredefinedKey, settings: Record<string, string | number>, trial = TRIAL) {
  const built = buildPredefined(key, settings);
  assert.ok(built.ok, built.ok ? "" : built.message);
  const scorer = { id: key, name: key, gating: true, definition: built.definition };
  assert.ok(evalScorerSchema.safeParse(scorer).success, `${key} is a valid eval scorer`);
  return scoreTrial(trial, [scorer], new Map()).scorers[0]?.status;
}

test("the set has fewer than 12 scorers, with our names and distinct keys", () => {
  assert.ok(PREDEFINED_SCORERS.length < 12);
  assert.equal(new Set(PREDEFINED_SCORERS.map(({ key }) => key)).size, PREDEFINED_SCORERS.length);
  assert.ok(PREDEFINED_SCORERS.every(({ kind }) => kind === "check" || kind === "judge"));
});

test("Output contains", () => {
  assert.equal(checkOn("output_contains", { value: "A200" }), "pass");
  assert.equal(checkOn("output_contains", { value: "B300" }), "fail");
});

test("Output equals a value", () => {
  const text = { ...TRIAL, output: "yes" };
  assert.equal(checkOn("output_equals", { value: "yes" }, text), "pass");
  assert.equal(checkOn("output_equals", { value: "no" }, text), "fail");
});

test("Output has a field", () => {
  assert.equal(checkOn("output_has_field", { field: "order" }), "pass");
  assert.equal(checkOn("output_has_field", { field: "refund" }), "fail");
});

test("Tool was called (the expected tool of task presets)", () => {
  assert.equal(checkOn("expected_tool", { tool: "lookup_order" }), "pass");
  assert.equal(checkOn("expected_tool", { tool: "refund_order" }), "fail");
});

test("Tool was not called", () => {
  assert.equal(checkOn("tool_not_called", { tool: "refund_order" }), "pass");
  assert.equal(checkOn("tool_not_called", { tool: "lookup_order" }), "fail");
});

test("Cost under a limit (the max cost of task presets)", () => {
  assert.equal(checkOn("max_cost_usd", { max: 0.01 }), "pass");
  assert.equal(checkOn("max_cost_usd", { max: 0.001 }), "fail");
});

test("Latency under a limit (the max latency of task presets)", () => {
  assert.equal(checkOn("max_latency_ms", { max: 2_000 }), "pass");
  assert.equal(checkOn("max_latency_ms", { max: 1_000 }), "fail");
});

for (const key of ["matches_expected", "follows_instructions", "is_safe"] as const) {
  test(`the judge ${key} asks a yes or no question`, () => {
    const built = buildPredefined(key, {});
    assert.ok(built.ok);
    assert.equal(built.definition.kind, "judge");
    const scorer = { id: key, name: key, gating: false, definition: built.definition };
    assert.ok(evalScorerSchema.safeParse(scorer).success);
  });
}

test("a missing or wrong setting is refused with the reason", () => {
  const missing = buildPredefined("expected_tool", {});
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.message, /tool/);
  const wrong = buildPredefined("max_cost_usd", { max: "cheap" });
  assert.equal(wrong.ok, false);
  assert.match(wrong.ok ? "" : wrong.message, /number/);
});
