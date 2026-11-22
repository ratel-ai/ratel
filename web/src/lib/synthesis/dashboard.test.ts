import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolsByName } from "@/lib/ingest/categorize";
import type { DailyAggregateRow } from "@/lib/ingest/otlp/queries";
import {
  buildDashboardModel,
  buildEfficiency,
  buildKpis,
  buildToolUsage,
  fmtCost,
  fmtDelta,
  halfDelta,
} from "@/lib/synthesis/dashboard";

const DAY = "2026-06-24";

function row(over: Partial<DailyAggregateRow> = {}): DailyAggregateRow {
  return {
    day: DAY,
    spend: { skills: 100, tools: 400, history: 800, memory: 50, user_input: 200 },
    splits: {
      tools_used: 100,
      tools_unused: 300,
      history_cached: 600,
      history_uncached: 200,
    },
    outputTokens: 0,
    latencyMs: 1000,
    costUsd: 12,
    runs: 4,
    ...over,
  };
}

test("buildDashboardModel splits tools and history by the reported ratio", () => {
  const { metrics } = buildDashboardModel([row()], [DAY]);
  const cat = metrics.tokens.byCategory;

  // tools 400 split 100:300 (25% used); history 800 split 600:200 (75% cached).
  assert.equal(cat.tools_used, 100);
  assert.equal(cat.tools_unused, 300);
  assert.equal(cat.history_cached, 600);
  assert.equal(cat.history_uncached, 200);

  // Non-split sources pass straight through.
  assert.equal(cat.skills, 100);
  assert.equal(cat.memory, 50);
  assert.equal(cat.user_input, 200);
});

test("split halves always sum back to their source total", () => {
  // Splits diverge from spend.tools (their sum is 200, not 400): re-scaling keeps
  // the halves summing to the source so the chart total never drifts.
  const { metrics } = buildDashboardModel(
    [
      row({
        splits: { tools_used: 50, tools_unused: 150, history_cached: 0, history_uncached: 0 },
      }),
    ],
    [DAY],
  );
  const { byCategory, bySource, total } = metrics.tokens;

  assert.equal(byCategory.tools_used + byCategory.tools_unused, bySource.tools);
  assert.equal(byCategory.tools_used, 100); // 400 × (50/200)
  assert.equal(byCategory.tools_unused, 300);

  // No split reported for history → the whole source falls to the cached half.
  assert.equal(byCategory.history_cached, bySource.history);
  assert.equal(byCategory.history_uncached, 0);

  // Grand total is unchanged by the split.
  assert.equal(total, 100 + 400 + 800 + 50 + 200);
});

test("byCategory rolls up to byCategory-derived bySource", () => {
  const { metrics } = buildDashboardModel([row()], [DAY]);
  const { byCategory, bySource } = metrics.tokens;
  assert.equal(byCategory.tools_used + byCategory.tools_unused, bySource.tools);
  assert.equal(byCategory.history_cached + byCategory.history_uncached, bySource.history);
});

test("buildToolUsage buckets each tool's footprint by per-event used/unused", () => {
  const perEvent: ToolsByName[] = [
    // Run 1: read + flaky called; dead shipped uncalled.
    {
      read: { calls: 2, tokens: 100 },
      flaky: { calls: 1, tokens: 50 },
      dead: { calls: 0, tokens: 500 },
    },
    // Run 2: read called; flaky shipped uncalled; dead shipped uncalled.
    {
      read: { calls: 3, tokens: 100 },
      flaky: { calls: 0, tokens: 50 },
      dead: { calls: 0, tokens: 500 },
    },
  ];
  const v = buildToolUsage(perEvent, 0);
  const by = Object.fromEntries(v.tools.map((t) => [t.name, t]));

  // read: always called → all footprint is "used".
  assert.equal(by.read.calls, 5);
  assert.equal(by.read.usedTokens, 200);
  assert.equal(by.read.unusedTokens, 0);

  // flaky: called once, shipped-idle once → footprint splits down the middle.
  assert.equal(by.flaky.calls, 1);
  assert.equal(by.flaky.usedTokens, 50);
  assert.equal(by.flaky.unusedTokens, 50);

  // dead: never called → all footprint is "unused".
  assert.equal(by.dead.calls, 0);
  assert.equal(by.dead.usedTokens, 0);
  assert.equal(by.dead.unusedTokens, 1000);

  // Default sort is by total token footprint, biggest first.
  assert.deepEqual(
    v.tools.map((t) => t.name),
    ["dead", "read", "flaky"],
  );
});

test("buildToolUsage spreads tools cost across tools by token share", () => {
  const perEvent: ToolsByName[] = [{ a: { calls: 1, tokens: 300 }, b: { calls: 0, tokens: 100 } }];
  const v = buildToolUsage(perEvent, 40); // 400 tokens total → $0.10 / 100 tokens
  const by = Object.fromEntries(v.tools.map((t) => [t.name, t]));
  assert.ok(Math.abs(by.a.usedCost - 30) < 1e-9); // 300/400 × 40
  assert.equal(by.a.unusedCost, 0);
  assert.ok(Math.abs(by.b.unusedCost - 10) < 1e-9); // 100/400 × 40
});

test("buildToolUsage on an empty window yields no tools", () => {
  const v = buildToolUsage([], 0);
  assert.deepEqual(v.tools, []);
});

test("buildToolUsage joins a runtime definition onto an already-observed tool", () => {
  const definition = {
    entryId: "read_file",
    provenance: "events" as const,
    name: "read_file",
    description: "Read project files",
    tags: ["filesystem"],
    inputSchema: { type: "object" },
    outputSchema: { type: "string" },
    searchableDescription: "open project documents",
    searchableDescriptionOverridden: true,
    useCloudDefinitions: false,
    searchableDescriptionOverride: null,
    lastSeenAt: new Date("2026-08-15T12:00:00.000Z"),
  };

  const usage = buildToolUsage([{ read_file: { calls: 2, tokens: 120 } }], 0, [definition]);

  assert.equal(usage.tools[0].calls, 2);
  assert.deepEqual(usage.tools[0].definition, definition);
});

test("fmtCost keeps 2 decimals at a cent+ but preserves sub-cent precision", () => {
  assert.equal(fmtCost(0), "$0.00");
  assert.equal(fmtCost(12.5), "$12.50");
  assert.equal(fmtCost(0.06), "$0.06");
  assert.equal(fmtCost(0.01), "$0.01");
  // Sub-cent no longer collapses to $0.00.
  assert.equal(fmtCost(0.004), "$0.0040");
  assert.equal(fmtCost(0.0003), "$0.00030");
});

test("halfDelta compares the recent half to the oldest half", () => {
  // First half sums to 20, last half to 60 → +200%, trending up.
  const up = halfDelta([10, 10, 30, 30]);
  assert.deepEqual(up, { pct: 2, dir: "up" });

  // Symmetric fall.
  const down = halfDelta([30, 30, 10, 10]);
  assert.equal(down?.dir, "down");

  // Flat within the dead-band.
  assert.equal(halfDelta([10, 10, 10, 10])?.dir, "flat");

  // No baseline (empty earlier half) or too few points → null.
  assert.equal(halfDelta([0, 0, 5, 5]), null);
  assert.equal(halfDelta([1, 2, 3]), null);
});

test("fmtDelta renders a signed whole percent with a true minus", () => {
  assert.equal(fmtDelta(0.12), "+12%");
  assert.equal(fmtDelta(-0.08), "−8%");
  assert.equal(fmtDelta(0), "0%");
});

test("buildKpis surfaces the four vitals with per-day series", () => {
  const days = ["2026-06-23", "2026-06-24"];
  const model = buildDashboardModel([row({ day: days[0] }), row({ day: days[1], runs: 6 })], days);
  const kpis = buildKpis(model);
  assert.deepEqual(
    kpis.map((k) => k.key),
    ["tokens", "cost", "latency", "runs"],
  );

  const runsKpi = kpis.find((k) => k.key === "runs")!;
  assert.equal(runsKpi.value, "10"); // 4 + 6
  assert.deepEqual(runsKpi.series, [4, 6]);
  assert.equal(runsKpi.upIsGood, true);

  // Latency series is per-run (day sum ÷ day runs), not the day's total latency.
  const latency = kpis.find((k) => k.key === "latency")!;
  assert.ok(Math.abs(latency.series[0] - 250) < 1e-6); // 1000/4
  assert.ok(Math.abs(latency.series[1] - 1000 / 6) < 1e-6);
});

test("buildEfficiency frames measured waste as a kept vs reclaimable split", () => {
  // One run: tools_unused 300 + history_uncached 200 = 500 reclaimable of 1550 total.
  const model = buildDashboardModel([row({ runs: 1 })], [DAY]);
  const eff = buildEfficiency(model);
  const total = 100 + 400 + 800 + 50 + 200; // 1550
  assert.equal(eff.hasWaste, true);
  assert.ok(Math.abs(eff.reclaimablePerRun - 500) < 1e-9);
  assert.ok(Math.abs(eff.keptPerRun - (total - 500)) < 1e-9);
  assert.ok(Math.abs(eff.efficiency - (total - 500) / total) < 1e-9);
  assert.ok(Math.abs(eff.unusedToolsPerRun - 300) < 1e-9);
  assert.ok(Math.abs(eff.uncachedHistoryPerRun - 200) < 1e-9);
});

test("cost distributes across split categories by token weight", () => {
  const { metrics } = buildDashboardModel([row()], [DAY]);
  const costCat = metrics.cost.byCategory;
  // Whole-day cost is preserved across the split.
  const totalCost =
    costCat.skills +
    costCat.tools_used +
    costCat.tools_unused +
    costCat.history_cached +
    costCat.history_uncached +
    costCat.memory +
    costCat.user_input;
  assert.ok(Math.abs(totalCost - 12) < 1e-9);
  // Cost tracks the token ratio: unused tools cost 3× used tools (300 vs 100).
  assert.ok(Math.abs(costCat.tools_unused - costCat.tools_used * 3) < 1e-9);
});
