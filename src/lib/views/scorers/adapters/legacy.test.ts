import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultScorers } from "@/lib/views/task-scorers/defaults";
import { scoreRun } from "@/lib/views/task-scorers/engine";
import type { Scorer as LegacyScorer, ScorerRun } from "@/lib/views/task-scorers/types";
import { scoreRecord } from "../domain/engine";
import { fromLegacy, legacyScorerId, precomputedJudge, recordFromLegacyRun } from "./legacy";

const RUNS: ScorerRun[] = [
  {
    firstList: ["a"],
    searches: 1,
    calls: ["a", "b", "c"],
    outcomes: ["ok", "ok", "ok"],
    failed: 0,
    answered: true,
    costUsd: 0.004,
    latencyMs: 800,
    criteriaPass: true,
  },
  { firstList: ["a"], searches: null, calls: null, failed: null },
  {
    firstList: null,
    searches: null,
    calls: ["a", "a", "b"],
    outcomes: ["error", "error", "ok"],
    failed: 2,
    costUsd: 0.02,
    latencyMs: 4000,
    criteriaPass: false,
  },
  { firstList: null, searches: null, calls: null, outcomes: null, failed: null },
  { firstList: null, searches: null, calls: ["a", "b"], outcomes: ["ok", "error"], failed: 1 },
  { firstList: null, searches: null, calls: ["a"], outcomes: ["ok"], failed: 0, answered: true },
  { firstList: null, searches: null, calls: ["a"], outcomes: ["ok"], failed: 0, answered: false },
  { firstList: null, searches: null, calls: ["a"], outcomes: ["error"], failed: 1 },
  { firstList: null, searches: null, calls: [], outcomes: [], failed: 0, answered: true },
  { firstList: null, searches: null, calls: [], outcomes: [], failed: 0 },
  { firstList: ["b", "a"], listKnown: false, searches: 1, calls: ["b"], failed: 0 },
  {
    firstList: ["b", "a"],
    searches: 1,
    calls: ["b", "a"],
    outcomes: ["ok"],
    failed: 0,
    costUsd: 0.01,
    latencyMs: 1000,
  },
];

const SCORERS: LegacyScorer[] = [
  { kind: "expected_tool", tool: "a" },
  { kind: "max_tool_calls", max: 2 },
  { kind: "ends_well" },
  { kind: "max_self_corrections", max: 1 },
  { kind: "max_cost_usd", max: 0.01 },
  { kind: "max_latency_ms", max: 1000 },
  { kind: "judge_criteria", criteria: "It answers." },
];

test("old scorers read through the adapter give the same pass, fail and skip", async () => {
  for (const [index, run] of RUNS.entries()) {
    const old = scoreRun(run, SCORERS).map((result) => result.status);
    const fresh = (
      await scoreRecord(
        recordFromLegacyRun(run),
        SCORERS.map((scorer) => fromLegacy("task-a", scorer)),
        { judge: precomputedJudge(run.criteriaPass) },
      )
    ).map((result) => result.status);
    assert.deepEqual(fresh, old, `run ${index}`);
  }
});

test("computed defaults read through the adapter give the same results", async () => {
  const defaults = defaultScorers({ selfCorrections: 0.4, costUsd: 0.008, latencyMs: 900 });
  assert.equal(defaults.length, 4);
  for (const [index, run] of RUNS.entries()) {
    const old = scoreRun(run, defaults).map((result) => result.status);
    const fresh = (
      await scoreRecord(
        recordFromLegacyRun(run),
        defaults.map((scorer) => fromLegacy("task-a", scorer)),
      )
    ).map((result) => result.status);
    assert.deepEqual(fresh, old, `run ${index}`);
  }
});

test("an adapted scorer keeps its switch, version and a stable id", () => {
  assert.deepEqual(
    fromLegacy("task-a", { kind: "max_latency_ms", max: 3000, enabled: false, version: 4 }),
    {
      kind: "check",
      config: { path: "latencyMs", op: "lte", value: 3000 },
      id: legacyScorerId("task-a", "max_latency_ms"),
      name: "Run time",
      scope: "task",
      taskId: "task-a",
      enabled: false,
      goodThreshold: 1,
      version: 4,
    },
  );
});
