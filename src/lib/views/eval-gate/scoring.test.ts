import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyChange } from "./change";
import { outcomeDefaults, rebasedForReplay } from "./defaults";
import { JUDGE_NOT_CONFIGURED, judgeCriteria, judgeLine } from "./judge";
import { CANT_SIMULATE, methodForKind, replayGap } from "./method";
import { resolveEvalModels, ruleJudge, SpendMeter } from "./models";
import { endsWellOf, selfCorrectionsOf } from "./outcome";
import { checkSide, pairSides, summarize } from "./score";
import { type CaseResult, type FixChange, NO_EXPECTATION, type RunRecord } from "./types";

/**
 * RC-61 part 1, fair scoring: which method each kind gets, checks scored only
 * when both sides measured them, the holdout verdict with the evidence apart,
 * the outcome checks' definitions, and the judge with and without a model.
 */

const failClearly = (name: string): FixChange => ({
  ...emptyChange(),
  dedupeRetries: [name],
  replay: { tools: [], failClearly: [name], prerequisite: null, skill: null },
});

test("each kind's method: retrieval kinds re-rank, behavioral kinds replay, the rest can't", () => {
  assert.equal(methodForKind("rewrite"), "rerank");
  assert.equal(methodForKind("fewer-results"), "rerank");
  assert.equal(methodForKind("fail-clearly"), "replay");
  assert.equal(methodForKind("merge"), "replay");
  assert.equal(methodForKind("skill"), "replay");
  assert.equal(methodForKind("build"), "none");
  assert.equal(replayGap("merge", emptyChange()), CANT_SIMULATE.noDefinition);
  assert.equal(replayGap("fail-clearly", failClearly("x")), null);
});

test("a check is scored only when both sides measured it", () => {
  const expected = { ...NO_EXPECTATION, tool: "a", maxToolCalls: 2, endsWell: true };
  const before = checkSide(
    {
      firstList: ["a"],
      searches: 1,
      calls: ["a", "b", "c"],
      outcomes: ["ok", "ok", "ok"],
      failed: 0,
      answered: true,
    },
    expected,
    null,
  );
  const after = checkSide(
    { firstList: ["a"], searches: null, calls: null, failed: null },
    expected,
    null,
  );
  const paired = pairSides(before, after);
  assert.equal(paired.comparable, 1, "only the first list is known on both sides");
  assert.equal(paired.before.pass, true, "the call count it fails isn't compared");
  assert.deepEqual(
    paired.before.checks.map((check) => [check.kind, check.measured]),
    [
      ["right_tool", true],
      ["max_tool_calls", false],
      ["ends_well", false],
    ],
  );
});

test("self-corrections and ending well use Self-corrections' own definitions", () => {
  // A retry of a, then a switch to b after the second failure.
  assert.equal(
    selfCorrectionsOf({ calls: ["a", "a", "b"], outcomes: ["error", "error", "ok"] }),
    2,
  );
  assert.equal(selfCorrectionsOf({ calls: null, outcomes: null }), null);
  assert.equal(endsWellOf({ calls: ["a", "b"], outcomes: ["ok", "error"] }), false);
  assert.equal(endsWellOf({ calls: ["a"], outcomes: ["ok"], answered: true }), true);
  assert.equal(endsWellOf({ calls: ["a"], outcomes: ["ok"], answered: false }), false);
});

test("the verdict reads the holdout; the evidence is tallied apart; can't-simulate runs say why", () => {
  const side = (pass: boolean) => ({
    pass,
    score: pass ? 1 : 0,
    checks: [
      {
        kind: "max_failed_calls" as const,
        pass,
        score: pass ? 1 : 0,
        detail: "",
        group: "target" as const,
        measured: true,
      },
    ],
    rank: null,
    calls: 1,
    searches: null,
    failed: 0,
  });
  const graded = (
    id: string,
    role: "holdout" | "evidence",
    before: boolean,
    after: boolean,
  ): CaseResult => ({
    caseId: id,
    turnId: id,
    simulated: true,
    skipped: null,
    before: side(before),
    after: side(after),
    role,
    method: "replay",
  });
  const results: CaseResult[] = [
    graded("1", "holdout", false, true),
    graded("2", "holdout", true, true),
    graded("3", "holdout", true, true),
    graded("e1", "evidence", false, true),
    graded("e2", "evidence", false, true),
    {
      caseId: "4",
      turnId: "4",
      simulated: false,
      skipped: "cant-simulate",
      before: null,
      after: null,
      role: "holdout",
      method: "none",
      methodNote: CANT_SIMULATE.noPrompts,
    },
  ];
  const summary = summarize(results, "seed");
  assert.deepEqual(
    [summary.before.passed, summary.after.passed, summary.nSimulated, summary.nCases],
    [2, 3, 3, 4],
  );
  assert.deepEqual(
    summary.evidence && [summary.evidence.before.passed, summary.evidence.after.passed],
    [0, 2],
  );
  assert.deepEqual(summary.methods, {
    rerank: 0,
    replay: 3,
    none: 1,
    reasons: [{ note: CANT_SIMULATE.noPrompts, runs: 1 }],
    fidelity: null,
  });
  // Nothing simulated by any method reads "can't simulate", not a number.
  assert.equal(summarize([results[5]!], "seed").verdict, "unsupported");
});

test("RC-69: replays that took the recorded path too rarely give no verdict; a failed replay counts against it", () => {
  const side = (pass: boolean) => ({
    pass,
    score: pass ? 1 : 0,
    checks: [
      {
        kind: "max_failed_calls" as const,
        pass,
        score: pass ? 1 : 0,
        detail: "",
        group: "target" as const,
        measured: true,
      },
    ],
    rank: null,
    calls: 1,
    searches: null,
    failed: 0,
  });
  const facts = (matches: boolean) => ({
    model: "m",
    recordedModel: null,
    steps: { before: 1, after: 1 },
    standIns: { before: 0, after: 0 },
    controlMatchesRecording: matches,
    paths: { recorded: ["a"], before: matches ? ["a"] : ["b"], after: ["a"] },
    capped: false,
  });
  const replayed = (id: string, matches: boolean): CaseResult => ({
    caseId: id,
    turnId: id,
    simulated: true,
    skipped: null,
    before: side(false),
    after: side(true),
    role: "holdout",
    method: "replay",
    replay: facts(matches),
  });
  const failed = (id: string): CaseResult => ({
    caseId: id,
    turnId: id,
    simulated: false,
    skipped: "cant-simulate",
    before: null,
    after: null,
    role: "holdout",
    method: "none",
    methodNote: CANT_SIMULATE.noCalls,
    replayFailed: true,
  });
  // 3 replayed (1 on the recorded path) and 3 that made no calls: 1 of 6.
  const low = summarize(
    [
      replayed("1", true),
      replayed("2", false),
      replayed("3", false),
      failed("4"),
      failed("5"),
      failed("6"),
    ],
    "seed",
  );
  assert.deepEqual(low.methods?.fidelity, { matched: 1, total: 6 });
  assert.equal(low.verdict, "unreliable");
  // Every replay failed: still unreliable, never "ends well".
  assert.equal(summarize([failed("1"), failed("2")], "seed").verdict, "unreliable");
  // At the threshold, the verdict stands.
  const ok = summarize(
    [replayed("1", true), replayed("2", true), replayed("3", false), replayed("4", false)],
    "seed",
  );
  assert.deepEqual(ok.methods?.fidelity, { matched: 2, total: 4 });
  assert.notEqual(ok.verdict, "unreliable");
});

test("criteria: no model means not judged; a judge reads both sides, within its cap", async () => {
  const view = {
    firstList: null,
    searches: null,
    calls: ["a"],
    outcomes: ["error" as const],
    failed: 1,
  };
  const good = { ...view, outcomes: ["ok" as const], failed: 0, answered: true };
  const item = { caseId: "c1", criteria: "Ends with the fare held.", before: view, after: good };
  const none = await judgeCriteria([item], null, new SpendMeter(1));
  assert.deepEqual(none.status, { status: "not-configured" });
  assert.deepEqual(none.readings.get("c1"), { before: null, after: null });
  assert.equal(judgeLine(none.status), JUDGE_NOT_CONFIGURED);

  const judged = await judgeCriteria([item], ruleJudge(), new SpendMeter(1));
  assert.deepEqual(judged.readings.get("c1"), { before: false, after: true });
  assert.equal(judged.status.status, "stand-in");

  const capped = await judgeCriteria(
    [item, { ...item, caseId: "c2" }],
    { ...ruleJudge(), standIn: false },
    new SpendMeter(0),
  );
  assert.deepEqual(capped.status, {
    status: "budget",
    model: "stand-in-model-local",
    runs: 0,
    skipped: 2,
  });
  assert.equal((await judgeCriteria([], null, new SpendMeter(1))).status.status, "no-criteria");
});

test("with no key there is no model; a placeholder key is no key", () => {
  assert.deepEqual(resolveEvalModels({}), { agent: null, tool: null, judge: null, standIn: false });
  assert.equal(resolveEvalModels({ ANTHROPIC_API_KEY: "REPLACE_ME" }).agent, null);
  assert.ok(
    resolveEvalModels({ ANTHROPIC_API_KEY: "sk-test" }).agent,
    "a key gives an agent (not called here)",
  );
});

test("RC-76: a local replay model override replaces the run's own model, locally only", () => {
  const env = { ANTHROPIC_API_KEY: "sk-test", EVAL_GATE_REPLAY_MODEL_OVERRIDE: "claude-haiku-5-5" };
  const local = resolveEvalModels(env, undefined, "development").agent!({
    recordedModel: "claude-sonnet-4-6",
    recorded: [],
  });
  assert.equal(local?.model, "claude-haiku-5-5");
  const prod = resolveEvalModels(env, undefined, "production").agent!({
    recordedModel: "claude-sonnet-4-6",
    recorded: [],
  });
  assert.equal(prod?.model, "claude-sonnet-4-6", "ignored outside local environments");
});

test("RC-76: cost and time limits drafted from the recording are read against the replayed baseline, not the recording", () => {
  const run = {
    turnId: "t",
    traceId: null,
    startedAt: "2026-10-20T00:00:00.000Z",
    taskId: null,
    steps: [],
    costUsd: 0.02,
    durationMs: 4_000,
  } as RunRecord;
  const drafted = { ...NO_EXPECTATION, ...outcomeDefaults(run) };
  const baseline = {
    firstList: null,
    searches: null,
    calls: ["a", "b"],
    failed: 0,
    costUsd: 0.04,
    latencyMs: 10_000,
  };
  const rebased = rebasedForReplay(drafted, run, baseline);
  assert.equal(rebased.maxCostUsd, 0.05);
  assert.equal(rebased.maxLatencyMs, 12_500);
  // A limit a person set stays as they set it.
  const edited = rebasedForReplay({ ...drafted, maxCostUsd: 0.01 }, run, baseline);
  assert.equal(edited.maxCostUsd, 0.01);
});
