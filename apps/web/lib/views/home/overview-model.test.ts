import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDashboardModel, type DashboardModel } from "@/lib/synthesis/dashboard";
import {
  buildContextSplit,
  compactCount,
  dailyCounts,
  dailyFailureShares,
  dailyReadings,
  hasTrend,
  parseOverviewWindow,
  percentChange,
  pointChange,
  pointDelta,
  previousWindow,
} from "@/lib/views/home/overview-model";

test("parseOverviewWindow accepts 30d and falls back to the week", () => {
  assert.equal(parseOverviewWindow("30d"), 30);
  assert.equal(parseOverviewWindow(["30d", "7d"]), 30);
  assert.equal(parseOverviewWindow("7d"), 7);
  assert.equal(parseOverviewWindow("90d"), 7);
  assert.equal(parseOverviewWindow(undefined), 7);
});

test("previousWindow is the same stretch one window earlier, cut at the same hour", () => {
  const since = new Date("2026-10-09T00:00:00.000Z");
  const now = new Date("2026-10-15T09:30:00.000Z");
  const previous = previousWindow({ since }, 7, now);
  assert.equal(previous.since.toISOString(), "2026-10-02T00:00:00.000Z");
  // Not 10-09 00:00: today is only 9.5 hours old, so the comparison is too.
  assert.equal(previous.until.toISOString(), "2026-10-08T09:30:00.000Z");
});

test("percentChange is signed, flat at zero and absent without a baseline", () => {
  assert.deepEqual(percentChange(120, 100), { direction: "up", text: "+20%" });
  assert.deepEqual(percentChange(80, 100), { direction: "down", text: "-20%" });
  assert.deepEqual(percentChange(100.2, 100), { direction: "flat", text: "0%" });
  assert.equal(percentChange(5, 0), null);
  assert.equal(percentChange(Number.NaN, 4), null);
});

test("point changes read in percentage points", () => {
  assert.deepEqual(pointChange(0.12, 0.08), { direction: "up", text: "+4 pts" });
  assert.deepEqual(pointDelta(-0.031), { direction: "down", text: "-3 pts" });
  assert.deepEqual(pointDelta(0.001), { direction: "flat", text: "0 pts" });
  assert.equal(pointChange(null, 0.1), null);
  assert.equal(pointDelta(null), null);
});

test("compactCount keeps small counts exact and abbreviates large ones", () => {
  assert.equal(compactCount(1284), "1,284");
  assert.equal(compactCount(12_400), "12.4K");
  assert.equal(compactCount(120_000), "120K");
  assert.equal(compactCount(1_000_000), "1M");
  assert.equal(compactCount(1_250_000), "1.3M");
  assert.equal(compactCount(999_499), "999K");
  assert.equal(compactCount(999_500), "1M");
});

test("dailyCounts zero-fills days without runs, in window order", () => {
  assert.deepEqual(
    dailyCounts([{ day: "2026-10-03", count: 4 }], ["2026-10-02", "2026-10-03", "2026-10-04"]),
    [0, 4, 0],
  );
});

const DAYS = ["2026-10-02", "2026-10-03", "2026-10-04"];

test("a daily reading leaves a gap, never a zero, on a day without one", () => {
  const rows = [
    { day: "2026-10-02", value: 1_200 },
    { day: "2026-10-04", value: Number.NaN },
  ];
  assert.deepEqual(
    dailyReadings(rows, DAYS, (row) => row.value),
    [1_200, null, null],
  );
  assert.deepEqual(
    dailyReadings(rows, DAYS, () => null),
    [null, null, null],
  );
});

test("each day's failed share counts only days with runs", () => {
  assert.deepEqual(
    dailyFailureShares(
      [
        { day: "2026-10-02", count: 10, errorCount: 2 },
        { day: "2026-10-03", count: 0, errorCount: 0 },
      ],
      DAYS,
    ),
    [0.2, null, null],
  );
});

test("a series has a trend once any day reads above zero", () => {
  assert.equal(hasTrend([null, 0, 0]), false);
  assert.equal(hasTrend([]), false);
  assert.equal(hasTrend([null, 0.1, 0]), true);
});

test("buildContextSplit is null without SDK context reports", () => {
  assert.equal(buildContextSplit(buildDashboardModel([], ["2026-10-01"])), null);
});

test("buildContextSplit orders sources by tokens and carries measurable waste", () => {
  const model = {
    hasData: true,
    runs: 10,
    metrics: {
      tokens: { bySource: { skills: 100, tools: 600, history: 300, memory: 0, user_input: 0 } },
    },
    breakdown: { toolsUnusedRate: 0.62, historyUncachedRate: 0.4 },
  } as unknown as DashboardModel;
  const split = buildContextSplit(model);
  assert.ok(split);
  assert.equal(split.totalTokens, 1000);
  assert.deepEqual(
    split.rows.map((row) => [row.source, row.share]),
    [
      ["tools", 0.6],
      ["history", 0.3],
      ["skills", 0.1],
    ],
  );
  assert.deepEqual(split.rows[0].waste, { label: "never called", share: 0.62 });
  assert.deepEqual(split.rows[1].waste, { label: "re-read uncached", share: 0.4 });
  assert.equal(split.rows[2].waste, null);
});
