import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OUTCOME_FLOOR,
  outcomeLost,
  outcomePillars,
  outcomeScore,
  PILLAR_WEIGHT,
  type PillarReading,
  RECOVERED_COST,
} from "@/lib/readings/trace-signals/health-outcomes";
import { emptyOtelDay } from "@/lib/readings/trace-signals/signals/otel-day";
import { type DayBucket, emptyBucket } from "@/lib/readings/trace-signals/signals/project-metrics";

const END = new Date("2026-11-08T00:00:00Z");
const WINDOW = { end: END, days: 7 };

/** An SDK day: 100 shaped runs, `deadEnds` of them dead ends, the right tool in the top 5 for `hits` of `judged`. */
function sdkDay(
  day: string,
  over: { deadEnds?: number; hits?: number; judged?: number } = {},
): DayBucket {
  const bucket = emptyBucket(day);
  return {
    ...bucket,
    turns: 100,
    shaped: 100,
    shapes: { ...bucket.shapes, direct: 100 - (over.deadEnds ?? 0), dead_end: over.deadEnds ?? 0 },
    // First try is low on purpose: the score reads the top 5, not the first pick.
    firstTry: 10,
    firstTryN: 100,
    top5: over.hits ?? 90,
    top5N: over.judged ?? 100,
  };
}

/** An OpenTelemetry day: 50 runs, 45 completed, 200 calls with 10 failed and 6 wasted, 5 switched. */
function otelDay(day: string): DayBucket {
  return {
    ...emptyBucket(day),
    turns: 50,
    otel: {
      ...emptyOtelDay(),
      turns: 50,
      completed: 45,
      calls: 200,
      failedCalls: 10,
      wasted: 6,
      shapes: { ...emptyOtelDay().shapes, otel_switched: 5 },
    },
  };
}

const byPillar = (readings: readonly PillarReading[]) =>
  Object.fromEntries(readings.map((r) => [r.pillar, r]));

test("an SDK project: runs end well, the right tool in the top 5 (not the first pick); no calls rate (the SDK counts no calls)", () => {
  const pillars = byPillar(
    outcomePillars({ daily: [sdkDay("2026-11-05", { deadEnds: 4, hits: 80 })] }, WINDOW),
  );
  assert.deepEqual(pillars.ended, { pillar: "ended", good: 0.96, n: 100 });
  assert.deepEqual(pillars.top_5, { pillar: "top_5", good: 0.8, n: 100 });
  assert.equal(pillars.calls, undefined);
  assert.equal(pillars.corrections, undefined, "no self-correction reading stored");
  assert.equal(pillars.tasks, undefined, "no tasks stored");
});

test("an OpenTelemetry project: completed runs and calls that worked; no top-5 rate without a search", () => {
  const pillars = byPillar(outcomePillars({ daily: [otelDay("2026-11-06")] }, WINDOW));
  assert.deepEqual(pillars.ended, { pillar: "ended", good: 0.9, n: 50 });
  assert.equal(pillars.top_5, undefined);
  assert.deepEqual(pillars.calls, { pillar: "calls", good: 1 - 16 / 200, n: 200 });
});

test("a mixed project adds both kinds of run into one rate", () => {
  const sdk = sdkDay("2026-11-05", { deadEnds: 10 });
  const pillars = byPillar(outcomePillars({ daily: [sdk, otelDay("2026-11-05")] }, WINDOW));
  assert.equal(pillars.ended?.n, 150);
  assert.equal(pillars.ended?.good, 1 - (10 + 5) / 150);
});

test("only the reading's own window counts: the comparison days before it are left out", () => {
  const before = sdkDay("2026-10-20", { deadEnds: 100 });
  const pillars = byPillar(outcomePillars({ daily: [before, sdkDay("2026-11-06")] }, WINDOW));
  assert.equal(pillars.ended?.good, 1);
  assert.equal(pillars.ended?.n, 100);
});

test("a rate below the evidence floor is left out", () => {
  const thin = {
    ...sdkDay("2026-11-06"),
    shaped: OUTCOME_FLOOR - 1,
    top5N: OUTCOME_FLOOR - 1,
    top5: 5,
  };
  assert.deepEqual(outcomePillars({ daily: [thin] }, WINDOW), []);
  assert.equal(outcomeScore([]), null);
});

test("self-corrections: a recovered one costs half; an older reading without the counts treats every one as unrecovered", () => {
  const stored = {
    version: 1,
    trust: { runs: "all", sessions: true },
    turns: 100,
    turnsWithReplies: 0,
    events: 30,
    correctedTurns: 20,
    recoveredTurns: 10,
  };
  const fresh = byPillar(
    outcomePillars({ daily: [], selfCorrections: stored }, WINDOW),
  ).corrections;
  assert.equal(fresh?.good, 1 - (10 + 10 * RECOVERED_COST) / 100);
  const older = byPillar(
    outcomePillars(
      {
        daily: [],
        selfCorrections: { ...stored, correctedTurns: undefined, recoveredTurns: undefined },
      },
      WINDOW,
    ),
  ).corrections;
  assert.equal(older?.good, 1 - 30 / 100, "events, at most one per run");
  assert.equal(
    byPillar(
      outcomePillars(
        { daily: [], selfCorrections: { ...stored, trust: { runs: "none" } } },
        WINDOW,
      ),
    ).corrections,
    undefined,
  );
});

test("tasks: failed runs over task runs, weighted by runs; none when runs were mixed together", () => {
  const workflows = {
    items: [
      { runs: 80, health: { failedRuns: 8 } },
      { runs: 20, health: { failedRuns: 10 } },
    ],
  };
  assert.equal(
    byPillar(outcomePillars({ daily: [], workflows }, WINDOW)).tasks?.good,
    1 - 18 / 100,
  );
  assert.equal(
    byPillar(
      outcomePillars(
        { daily: [], workflows: { ...workflows, basis: { blocked: "mixed_runs" } } },
        WINDOW,
      ),
    ).tasks,
    undefined,
  );
});

test("the measured half: weights shared out among the rates there are, and its missing points add up", () => {
  const all: PillarReading[] = [
    { pillar: "ended", good: 0.9, n: 100 },
    { pillar: "top_5", good: 0.8, n: 100 },
    { pillar: "corrections", good: 1, n: 100 },
    { pillar: "tasks", good: 0.5, n: 100 },
    { pillar: "calls", good: 1, n: 100 },
  ];
  const expected = 100 * (0.35 * 0.9 + 0.2 * 0.8 + 0.2 + 0.15 * 0.5 + 0.1);
  assert.ok(Math.abs((outcomeScore(all) ?? 0) - expected) < 1e-9);
  const two = all.slice(0, 2);
  assert.ok(
    Math.abs(
      (outcomeScore(two) ?? 0) -
        (100 * (0.35 * 0.9 + 0.2 * 0.8)) / (PILLAR_WEIGHT.ended + PILLAR_WEIGHT.top_5),
    ) < 1e-9,
  );
  const lost = [...outcomeLost(all).values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(lost - (100 - (outcomeScore(all) ?? 0))) < 1e-9);
  assert.ok(
    Math.abs(Object.values(PILLAR_WEIGHT).reduce((a, b) => a + b, 0) - 1) < 1e-9,
    "the weights add up to one",
  );
});

test("a reading stored before the top-5 count has no top-5 rate, rather than a different one", () => {
  const older = { ...sdkDay("2026-11-06") };
  delete older.top5;
  delete older.top5N;
  assert.equal(byPillar(outcomePillars({ daily: [older] }, WINDOW)).top_5, undefined);
});
