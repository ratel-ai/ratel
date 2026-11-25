import assert from "node:assert/strict";
import { test } from "node:test";
import { focusedStats } from "@/components/console/home/overview-stats";
import type { TraceAggregateSummary } from "@/lib/synthesis/traces/queries";
import { MOCK_HEALTH_MODEL } from "@/lib/views/health/mock-fixture";
import {
  type FocusedReads,
  loadFocusedOverview,
  type MetricsData,
} from "@/lib/views/home/focused-load";
import {
  changeLayout,
  DEFAULT_LAYOUT,
  OVERVIEW_WIDGETS,
  type OverviewLayout,
  type OverviewWidgetId,
} from "@/lib/views/overview-layout/domain/layout";
import { topologyModel } from "@/lib/views/project-entities/topology";

/** The recap Overview's loader: which read each widget causes, and what a failed one costs. */

const NOW = new Date("2026-11-24T12:00:00.000Z");
const PROJECT = { id: "p1", name: "Support bot", slug: "support-bot", isDemo: false };
const ORGANIZATION = { id: "o1" } as Parameters<typeof loadFocusedOverview>[0]["organization"];
const LIMITS = {
  agentHealthSignalsShown: Number.POSITIVE_INFINITY,
  agentHealthEvidenceTurns: 3,
  agentHealthWindowDays: 90,
};
const GRAPH = topologyModel({
  agents: [],
  handoffs: [],
  servers: [],
  calls: [],
  hidden: new Set(),
  names: new Map(),
});
const RUNS: TraceAggregateSummary = {
  count: 40,
  errorCount: 8,
  errorRate: 0.2,
  p50DurationMs: 900,
  p95DurationMs: 4_000,
  p99DurationMs: 6_000,
  costUsd: 1.5,
  totalTokens: 90_000,
  volume: [{ day: "2026-11-23", count: 40, errorCount: 8 }],
};
const NO_RUNS = {
  ...RUNS,
  count: 0,
  errorCount: 0,
  errorRate: 0,
  p50DurationMs: null,
  volume: [],
};
const SDK_DAY = { day: "2026-11-23", searches: 12, toolCalls: 4, skillRuns: 0 };
const fail = async () => {
  throw new Error("statement timeout");
};

const BASE: FocusedReads = {
  telemetry: async () => ({
    hasEvents: false,
    hasSpans: true,
    latestEventAt: null,
    latestSpanAt: NOW,
  }),
  sdkLatestAt: async () => null,
  traces: async () => RUNS,
  previous: async () => ({ ...RUNS, count: 20 }),
  dailyTraces: async () => [],
  sdkDays: async () => [],
  sdkPrevious: async () => ({ searches: 0, toolCalls: 0, skillRuns: 0 }),
  health: async () => MOCK_HEALTH_MODEL,
  topology: async () => GRAPH,
  fixes: async () => ({ open: [], applied: [], rewritesOn: false }),
  pendingRewrites: async () => 3,
  intents: async () => null,
  tasks: async () => null,
  dailyAggregates: async () => [],
  dashboards: async () => ({}),
  context: async () => ({ split: null, suggestions: [], promptCacheHitRate: null }),
};
const ALWAYS = ["sdkLatestAt", "telemetry"];

async function load(over: Partial<FocusedReads> = {}, layout: OverviewLayout = DEFAULT_LAYOUT) {
  const ran: string[] = [];
  const reads = Object.fromEntries(
    Object.entries({ ...BASE, ...over }).map(([name, read]) => [
      name,
      (...args: unknown[]) => {
        ran.push(name);
        return (read as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  ) as unknown as FocusedReads;
  const data = await loadFocusedOverview({
    project: PROJECT,
    organization: ORGANIZATION,
    window: 7,
    now: NOW,
    layout,
    reads,
    limits: LIMITS,
  });
  return { data, ran: ran.sort() };
}

const only = (...ids: OverviewWidgetId[]): OverviewLayout =>
  OVERVIEW_WIDGETS.filter((id) => !ids.includes(id)).reduce<OverviewLayout>(
    (layout, widget) => changeLayout(layout, { kind: "remove", widget }),
    DEFAULT_LAYOUT,
  );
const labels = (metrics: MetricsData | "failed" | null) => {
  assert.ok(metrics && metrics !== "failed");
  return focusedStats(metrics).map(({ label }) => label);
};

test("each read runs once, and a removed widget causes none of its own", async () => {
  const attention = ["dailyAggregates", "fixes", "health", "intents", "tasks", "traces"];
  const metrics = ["dailyTraces", "previous", "sdkDays", "sdkPrevious", "traces"];
  const expected: [OverviewWidgetId[], string[]][] = [
    [[], []],
    [["metrics"], metrics],
    [["topology"], ["topology"]],
    [["health"], ["health"]],
    [["attention"], attention],
    [["metrics", "attention"], [...new Set([...metrics, ...attention])]],
    [["health", "attention"], attention],
    [
      ["topology", "health"],
      ["health", "topology"],
    ],
  ];
  for (const [ids, reads] of expected) {
    const { data, ran } = await load({}, only(...ids));
    assert.deepEqual(ran, [...ALWAYS, ...reads].sort(), ids.join("+") || "all removed");
    for (const id of OVERVIEW_WIDGETS)
      assert.equal(data[id] === null, !ids.includes(id), `${id} in ${ids}`);
  }
});

test("the stats are runs, failed runs, median duration and spend, also with a Health reading", async () => {
  const { data } = await load();
  assert.ok(data.metrics && data.metrics !== "failed");
  const stats = focusedStats(data.metrics);
  assert.deepEqual(
    stats.map(({ label, value }) => [label, value]),
    [
      ["Runs", "40"],
      ["Failed runs", "20%"],
      ["Median duration", "900ms"],
      ["Spend", "$1.50"],
    ],
  );
  assert.equal(stats[0].delta?.value, "+100%");
  assert.equal(stats[1].href, "/project/p1/traces?range=7d&errorOnly=1");
  assert.equal(stats[3].peek, "context");
});

test("a project with SDK events only keeps its own stats", async () => {
  const sdk = { traces: async () => NO_RUNS, sdkDays: async () => [SDK_DAY] };
  const { data, ran } = await load(sdk, only("metrics"));
  assert.ok(ran.includes("health"), "the first try tile is Agent health's");
  assert.deepEqual(labels(data.metrics).slice(0, 1), ["Searches"]);
  const without = await load({ ...sdk, health: fail }, only("metrics"));
  assert.deepEqual(labels(without.data.metrics), ["Searches", "Tool calls", "Skill runs"]);
});

test("no runs yet: the stats say so and nothing needs attention", async () => {
  const { data } = await load({
    traces: async () => NO_RUNS,
    health: async () => ({ ...MOCK_HEALTH_MODEL, signals: [], lockedCount: 0 }),
  });
  assert.ok(data.metrics && data.metrics !== "failed");
  assert.equal(focusedStats(data.metrics)[0].hint, "None in the last 7 days");
  assert.deepEqual(data.attention?.items, []);
  assert.equal(data.attention?.partial, false);
});

test("a failed read costs its own widget only", async () => {
  const noTraces = (await load({ traces: fail })).data;
  assert.equal(noTraces.metrics, "failed");
  assert.equal(noTraces.attention?.partial, true);
  assert.ok((noTraces.attention?.items.length ?? 0) > 0, "the issues still show");

  const noMap = (await load({ topology: fail })).data;
  assert.equal(noMap.topology, "failed");
  assert.notEqual(noMap.metrics, "failed");

  const noHealth = (await load({ health: fail })).data;
  assert.deepEqual(noHealth.health?.card, {
    kind: "state",
    line: "The Health score did not load.",
    failed: true,
  });
  assert.equal(noHealth.attention?.partial, true);
  assert.equal(labels(noHealth.metrics)[1], "Failed runs");

  for (const name of ["previous", "dailyTraces", "sdkDays", "sdkPrevious"] as const)
    assert.equal(labels((await load({ [name]: fail })).data.metrics).length, 4, name);
  for (const name of ["intents", "tasks", "dailyAggregates"] as const)
    assert.equal((await load({ [name]: fail })).data.attention?.partial, true, name);
});

test("Quality's own count stands in for Fixes, and is read only then", async () => {
  const { data, ran } = await load({
    fixes: fail,
    traces: async () => NO_RUNS,
    health: async () => ({ ...MOCK_HEALTH_MODEL, signals: [], lockedCount: 0 }),
  });
  assert.ok(ran.includes("pendingRewrites"));
  assert.deepEqual(
    data.attention?.items.map(({ key }) => key),
    ["rewrites"],
  );
  assert.equal(data.attention?.partial, false);
  assert.equal((await load({ fixes: fail, pendingRewrites: fail })).data.attention?.partial, true);
});

test("the issue rows open the issue on Agent health", async () => {
  const { data } = await load();
  const issue = data.attention?.items.find(({ key }) => key.startsWith("issue:"));
  assert.ok(issue?.target.kind === "link");
  const id = issue.key.slice("issue:".length);
  assert.equal(
    issue.target.href,
    `/project/p1/health?peek=${encodeURIComponent(`issue:${id}`)}#signal-${id}`,
  );
});

test("a low-confidence reading is read once, whichever widgets share it", async () => {
  const health = async () => ({
    ...MOCK_HEALTH_MODEL,
    turns: 24,
    floor: 10,
    lowConfidence: { turns: 24, firmsUpAt: 50 },
  });
  for (const ids of [
    OVERVIEW_WIDGETS,
    ["health", "metrics"],
    ["attention", "metrics"],
    ["health", "attention"],
  ] as const) {
    const { ran } = await load(
      { health, traces: async () => NO_RUNS, sdkDays: async () => [SDK_DAY] },
      only(...ids),
    );
    assert.equal(ran.filter((name) => name === "health").length, 1, ids.join("+"));
  }
});
