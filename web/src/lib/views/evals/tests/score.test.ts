import assert from "node:assert/strict";
import { test } from "node:test";
import type { CheckConfig } from "@/lib/contracts/check";
import type { EvalScorer } from "../domain/eval";
import {
  checkTrial,
  definitionHash,
  type JudgeOutcome,
  scoreTrial,
  snapshotOf,
  type TrialRecord,
} from "../domain/score";
import { scoreRun } from "../experiments";
import { NO_REFUND } from "./support";

const trial = (over: Partial<TrialRecord> = {}): TrialRecord => ({
  output: "I cannot refund A200.",
  toolCalls: [
    { name: "lookup_order", arguments: { order_id: "A200" } },
    { name: "crm.notes.add", arguments: { note: { text: "late" } } },
  ],
  durationMs: 1200,
  costUsd: 0.02,
  inputTokens: 100,
  outputTokens: 20,
  ...over,
});
const judge = (gating: boolean): EvalScorer => ({
  id: "j",
  name: "Polite",
  gating,
  definition: { kind: "judge", config: { prompt: "Is it polite?", output: "boolean" } },
});
const said = (passed: boolean): JudgeOutcome => ({
  status: "answered",
  passed,
  reason: `${passed ? "Yes" : "No"}, with a confidence of 90%.`,
  confidence: 0.9,
  model: "m",
});
const refused: JudgeOutcome = {
  status: "not_scored",
  code: "refused_budget",
  reason: "The judge budget of this organization for today (100 USD) is used.",
};
const score = (scorer: EvalScorer, outcome: JudgeOutcome) =>
  scoreTrial(trial(), [NO_REFUND, scorer], new Map([["j", outcome]]));

const CHECKS: [string, CheckConfig, "pass" | "fail"][] = [
  ["output", { path: "output", op: "contains", value: "cannot refund" }, "pass"],
  ["output", { path: "output", op: "contains", value: "refunded" }, "fail"],
  ["tool call is there", { path: "tools", op: "eq", value: "lookup_order" }, "pass"],
  ["tool call is there", { path: "tools", op: "eq", value: "refund_order" }, "fail"],
  ["tool call is not there", { path: "tools", op: "ne", value: "refund_order" }, "pass"],
  ["tool call is not there", { path: "tools", op: "ne", value: "lookup_order" }, "fail"],
  ["argument", { path: "tool_arguments.lookup_order.order_id", op: "eq", value: "A200" }, "pass"],
  ["argument", { path: "tool_arguments.lookup_order.order_id", op: "eq", value: "A1" }, "fail"],
  ["argument of no call", { path: "tool_arguments.refund_order.id", op: "eq", value: "A" }, "fail"],
  [
    "argument, nested, of a tool with dots",
    { path: "tool_arguments.crm.notes.add.note.text", op: "eq", value: "late" },
    "pass",
  ],
  ["cost limit", { path: "cost_usd", op: "lte", value: 0.05 }, "pass"],
  ["cost limit", { path: "cost_usd", op: "lte", value: 0.01 }, "fail"],
  ["latency limit", { path: "duration_ms", op: "lt", value: 2000 }, "pass"],
  ["latency limit", { path: "duration_ms", op: "lt", value: 1000 }, "fail"],
  ["tokens", { path: "total_tokens", op: "eq", value: 120 }, "pass"],
];
for (const [name, config, status] of CHECKS) {
  test(`${name}: ${config.op} ${config.value} is a ${status}`, () => {
    const result = checkTrial(config, trial());
    assert.equal(result.status, status);
    assert.ok(result.reason.includes(config.path));
  });
}

test("a field of a JSON output", () => {
  const record = trial({ output: { status: "refused", n: null } });
  assert.equal(
    checkTrial({ path: "output.status", op: "eq", value: "refused" }, record).status,
    "pass",
  );
  assert.equal(checkTrial({ path: "output.none", op: "exists" }, record).status, "fail");
  assert.equal(checkTrial({ path: "output.none", op: "ne", value: "x" }, record).status, "fail");
});

test("no tool call", () => {
  const record = trial({ toolCalls: [] });
  assert.equal(checkTrial({ path: "tools", op: "ne", value: "x" }, record).status, "pass");
  assert.equal(checkTrial({ path: "tools", op: "exists" }, record).status, "fail");
});

test("usage that the agent did not report has no result, so a gating limit makes invalid", () => {
  const record = trial({ costUsd: null });
  const config = { path: "cost_usd", op: "lte", value: 1 } as const;
  assert.equal(checkTrial(config, record).status, "not_scored");
  const scorer = { ...NO_REFUND, id: "c", definition: { kind: "check" as const, config } };
  assert.equal(scoreTrial(record, [scorer], new Map()).result, "invalid");
});

test("a failing advisory judge does not change a pass, and its answer and reason stay", () => {
  const { result, scorers } = score(judge(false), said(false));
  assert.equal(result, "pass");
  assert.deepEqual(scorers[1], {
    scorerId: "j",
    name: "Polite",
    kind: "judge",
    gating: false,
    status: "fail",
    reason: "No, with a confidence of 90%.",
    confidence: 0.9,
    model: "m",
  });
});

test("a gating judge decides", () => {
  assert.equal(score(judge(true), said(false)).result, "fail");
  assert.equal(score(judge(true), said(true)).result, "pass");
});

const noEngine: JudgeOutcome = {
  status: "not_scored",
  code: "not_configured",
  reason: "No judge is configured.",
};
const refund = trial({ toolCalls: [{ name: "refund_order", arguments: {} }] });
/** The result, and what is stored of the judge. */
const outcome = (record: TrialRecord, gating: boolean, judged: JudgeOutcome) => {
  const { result, invalidReason, scorers } = scoreTrial(
    record,
    [NO_REFUND, judge(gating)],
    new Map([["j", judged]]),
  );
  return { result, invalidReason, judge: [scorers[1]?.status, scorers[1]?.reason] };
};
const BUDGET = "The judge budget of this organization for today (100 USD) is used.";

test("(a) a gating check fails, the gating judge is refused: a real gating failure wins", () => {
  assert.deepEqual(outcome(refund, true, refused), {
    result: "fail",
    invalidReason: null,
    judge: ["not_scored", BUDGET],
  });
});

test("(b) all gating checks pass, the gating judge is refused: invalid with the budget reason", () => {
  assert.deepEqual(outcome(trial(), true, refused), {
    result: "invalid",
    invalidReason: `The gating scorer Polite has no result: ${BUDGET}`,
    judge: ["not_scored", BUDGET],
  });
});

test("(c) all gating checks pass, the gating judge has no engine: invalid", () => {
  assert.deepEqual(outcome(trial(), true, noEngine), {
    result: "invalid",
    invalidReason: "The gating scorer Polite has no result: No judge is configured.",
    judge: ["not_scored", "No judge is configured."],
  });
});

test("(d) a gating check fails, the advisory judge is refused: fail", () => {
  assert.deepEqual(outcome(refund, false, refused), {
    result: "fail",
    invalidReason: null,
    judge: ["not_scored", BUDGET],
  });
});

test("(e) all gating checks pass, the advisory judge is refused: pass", () => {
  assert.deepEqual(outcome(trial(), false, refused), {
    result: "pass",
    invalidReason: null,
    judge: ["not_scored", BUDGET],
  });
});

for (const status of ["infra_error", "timed_out"] as const) {
  test(`(f) the sandbox gives ${status}: invalid before any scoring`, async () => {
    const run = { status, reason: "it stopped", traceId: null, result: null };
    const scored = await scoreRun(
      { scorerSnapshots: { v1: [snapshotOf(NO_REFUND), snapshotOf(judge(true))] } } as never,
      { caseVersionId: "v1" } as never,
      {} as never,
      run as never,
      // Any use of a scorer or of the judge reads this and throws.
      new Proxy({}, { get: () => assert.fail("nothing is scored") }) as never,
    );
    assert.deepEqual(
      [scored.result, scored.reason, scored.scorers],
      ["invalid", `${status}: it stopped`, []],
    );
  });
}

test("the same definition has the same hash, and a changed one has another", () => {
  const hash = definitionHash(NO_REFUND.definition);
  const same = { config: { value: "refund_order", op: "ne", path: "tools" }, kind: "check" };
  assert.equal(definitionHash(same as typeof NO_REFUND.definition), hash);
  assert.notEqual(
    definitionHash({ kind: "check", config: { path: "tools", op: "eq", value: "refund_order" } }),
    hash,
  );
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(snapshotOf(NO_REFUND), { ...NO_REFUND, hash });
});

test("an order on a tool argument holds for each call", () => {
  const record = trial({
    toolCalls: [
      { name: "refund", arguments: { amount: 40 } },
      { name: "refund", arguments: { amount: 60 } },
    ],
  });
  const check = (op: "lt" | "gt", value: number) =>
    checkTrial({ path: "tool_arguments.refund.amount", op, value }, record).status;
  assert.equal(check("lt", 100), "pass");
  assert.equal(check("lt", 50), "fail");
  assert.equal(check("gt", 10), "pass");
});

test("an argument path reads the tool that has the argument", () => {
  const record = trial({
    toolCalls: [
      { name: "a", arguments: { b: { c: 1 } } },
      { name: "a.b", arguments: { other: 2 } },
    ],
  });
  assert.equal(
    checkTrial({ path: "tool_arguments.a.b.c", op: "eq", value: 1 }, record).status,
    "pass",
  );
});
