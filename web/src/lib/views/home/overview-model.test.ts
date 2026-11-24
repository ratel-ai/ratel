import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDashboardModel, type DashboardModel } from "@/lib/synthesis/dashboard";
import {
  buildContextSplit,
  compactCount,
  parseOverviewWindow,
} from "@/lib/views/home/overview-model";

test("parseOverviewWindow accepts 30d and falls back to the week", () => {
  assert.equal(parseOverviewWindow("30d"), 30);
  assert.equal(parseOverviewWindow(["30d", "7d"]), 30);
  assert.equal(parseOverviewWindow("7d"), 7);
  assert.equal(parseOverviewWindow("90d"), 7);
  assert.equal(parseOverviewWindow(undefined), 7);
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
