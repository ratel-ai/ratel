import assert from "node:assert/strict";
import { test } from "node:test";
import {
  doesTheWork,
  rebaseScorers,
  replayLimits,
  scoreReplaySide,
  sideScore,
} from "@/lib/views/task-scorers/replay";
import type { Scorer } from "@/lib/views/task-scorers/types";

test("doesTheWork is not read where the replay side carries no coverage", () => {
  assert.equal(doesTheWork({}), null);
  assert.equal(doesTheWork({ coversRecording: null }), null);
});

test("doesTheWork passes a side that made every recorded call", () => {
  assert.deepEqual(doesTheWork({ coversRecording: true }), {
    pass: true,
    detail: "makes every call the run made",
  });
});

test("doesTheWork fails a side that stopped short or that only a stand-in answered", () => {
  assert.deepEqual(doesTheWork({ coversRecording: false }), {
    pass: false,
    detail: "stops short of what the run did",
  });
  assert.deepEqual(doesTheWork({ coversRecording: false, workUnverified: true }), {
    pass: false,
    detail: "asks the merged tool for what the run never did; the replay can't vouch it worked",
  });
});

test("sideScore is the mean of the measured scores", () => {
  assert.equal(sideScore([1, 0, 0.5], null), 0.5);
  assert.equal(sideScore([], null), 0);
});

test("sideScore is 0 for a side short of the run's work, whatever its other scores", () => {
  assert.equal(sideScore([1, 1, 0], { pass: false }), 0);
  assert.equal(sideScore([1, 1, 0], { pass: true }), 2 / 3);
});

test("replayLimits gives the baseline the drafted room and rounding", () => {
  assert.deepEqual(replayLimits({ costUsd: 0.01, latencyMs: 1000 }), {
    maxCostUsd: 0.0125,
    maxLatencyMs: 1250,
  });
  assert.deepEqual(replayLimits({ costUsd: 0.000_011, latencyMs: 999.1 }), {
    maxCostUsd: 0.0001,
    maxLatencyMs: 1249,
  });
  assert.deepEqual(replayLimits({ costUsd: null, latencyMs: undefined }), {
    maxCostUsd: null,
    maxLatencyMs: null,
  });
});

test("rebaseScorers moves drafted cost and time limits to the baseline and keeps the rest", () => {
  const scorers: Scorer[] = [
    { kind: "ends_well" },
    { kind: "max_cost_usd", max: 0.001 },
    { kind: "max_latency_ms", max: 500 },
    { kind: "max_tool_calls", max: 2 },
  ];
  const rebased = rebaseScorers(scorers, { costUsd: 0.02, latencyMs: 4000 }, () => true);
  assert.deepEqual(rebased, [
    { kind: "ends_well" },
    { kind: "max_cost_usd", max: 0.025 },
    { kind: "max_latency_ms", max: 5000 },
    { kind: "max_tool_calls", max: 2 },
  ]);
});

test("rebaseScorers keeps a limit a person set, and a limit the baseline can't measure", () => {
  const scorers: Scorer[] = [
    { kind: "max_cost_usd", max: 0.001 },
    { kind: "max_latency_ms", max: 500 },
  ];
  const userCost = (scorer: Scorer) => scorer.kind !== "max_cost_usd";
  assert.deepEqual(rebaseScorers(scorers, { costUsd: 0.02, latencyMs: null }, userCost), scorers);
});

test("scoreReplaySide fails every measured scorer of a side short of the run's work, and keeps a skip a skip", () => {
  const scorers: Scorer[] = [
    { kind: "ends_well" },
    { kind: "max_tool_calls", max: 1 },
    { kind: "judge_criteria", criteria: "Takes the seat." },
    { kind: "expected_tool", tool: "x" },
  ];
  const side = {
    firstList: null,
    listKnown: false,
    searches: null,
    calls: ["seat_map_then_select"],
    outcomes: ["ok" as const],
    failed: 0,
    answered: true,
    criteriaPass: true,
  };
  const done = scoreReplaySide({ ...side, coversRecording: true }, scorers);
  assert.deepEqual(
    done.map((result) => result.status),
    ["pass", "pass", "pass", "skip"],
  );
  const guessed = scoreReplaySide(
    { ...side, coversRecording: false, workUnverified: true },
    scorers,
  );
  assert.deepEqual(
    guessed.map((result) => result.status),
    ["fail", "fail", "fail", "skip"],
  );
  assert.deepEqual(
    guessed.map((result) => result.score),
    [0, 0, 0, 0],
  );
  assert.match(guessed[0]!.detail, /can't vouch/);
});

test("scoreReplaySide is scoreRun where the side carries no coverage", () => {
  const scorers: Scorer[] = [{ kind: "max_tool_calls", max: 1 }];
  const side = { firstList: null, searches: null, calls: ["a", "b"], failed: 0 };
  assert.deepEqual(scoreReplaySide(side, scorers), [
    { kind: "max_tool_calls", status: "fail", score: 0, detail: "2 calls" },
  ]);
});
