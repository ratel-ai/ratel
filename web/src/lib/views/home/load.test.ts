import assert from "node:assert/strict";
import { test } from "node:test";
import type { HealthPageModel, HealthTile } from "@/lib/readings/trace-signals/view";
import type { TraceAggregateSummary } from "@/lib/synthesis/traces/queries";
import type { Fix } from "@/lib/views/fixes/types";
import { pendingHealthModel } from "@/lib/views/health/page-model";
import { signal } from "@/lib/views/health/workflows-view-fixtures";
import type { FixesSlice } from "@/lib/views/home/glance";
import {
  firstTryTile,
  fixTarget,
  issuePanelHref,
  overviewAttention,
  overviewDaily,
  overviewSdk,
} from "@/lib/views/home/load";

const DAYS = ["2026-10-13", "2026-10-14", "2026-10-15"];
const TRACES: TraceAggregateSummary = {
  count: 40,
  errorCount: 8,
  errorRate: 0.2,
  p50DurationMs: 900,
  p95DurationMs: 4_000,
  p99DurationMs: 6_000,
  costUsd: 1.5,
  totalTokens: 90_000,
  volume: [{ day: "2026-10-14", count: 40, errorCount: 8 }],
};

function readyHealth(): HealthPageModel {
  const firstTry = {
    key: "first_try",
    label: "First try",
    value: 0.7,
    unit: "share",
    interval: null,
    sub: "70 of 100 turns found the tool first",
    tier: "observed",
    upIsGood: true,
    delta: 0.02,
    series: [],
    n: 100,
  } as unknown as HealthTile;
  return {
    ...pendingHealthModel(30),
    turns: 500,
    floor: 50,
    tiles: [firstTry],
    signals: [
      signal("a", "error_loop", "tool", "upload", ["upload"]),
      signal("b", "latency_outlier", "tool", "search", ["search"]),
    ],
    tooEarly: [],
    lockedCount: 0,
  };
}

function attention(overrides: Partial<Parameters<typeof overviewAttention>[0]> = {}) {
  return overviewAttention({
    projectId: "p1",
    window: 7,
    traces: TRACES,
    health: null,
    healthWindow: 7,
    fixes: null,
    pendingRewrites: null,
    tasks: { byId: {}, steps: [] },
    unanswered: [],
    contextSuggestions: [],
    contextSplit: null,
    ...overrides,
  });
}

test("the window's days fill the numbers' series, and a day without runs is a gap", () => {
  const day = {
    day: "2026-10-14",
    traceCount: 40,
    errorTraceCount: 8,
    averageLatencyMs: 1_100,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 1.5,
  };
  assert.deepEqual(overviewDaily({ traces: TRACES, dailyTraces: [day] }, DAYS), {
    failedShare: [null, 0.2, null],
    duration: [null, 1_100, null],
    spend: [null, 1.5, null],
  });
  assert.deepEqual(overviewDaily({ traces: null, dailyTraces: null }, DAYS).duration, [
    null,
    null,
    null,
  ]);
});

test("failing runs lead the list, and an unread window has no failure share", () => {
  const [first] = attention().items;
  assert.equal(first!.key, "errors");
  assert.deepEqual(first!.target, {
    kind: "link",
    href: "/project/p1/traces?range=7d&errorOnly=1",
  });
  assert.equal(attention({ traces: null }).items.length, 0);
});

test("an issue opens its panel in the Agent health window, and the ones the plan hides are counted", () => {
  const health = { signals: readyHealth().signals.slice(0, 1), lockedCount: 1 };
  const { items, moreIssues } = attention({ health, healthWindow: 30 });
  const issues = items.filter((item) => item.key.startsWith("issue:"));
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0]!.target, {
    kind: "link",
    href: "/project/p1/health?days=30&peek=issue%3Aa#signal-a",
  });
  assert.equal(moreIssues, 1);
});

test("the first try tile shows once Agent health has a reading", () => {
  assert.equal(firstTryTile(readyHealth())?.value, 0.7);
  assert.equal(firstTryTile({ ...readyHealth(), turns: 10 }), null);
});

test("description updates ready open Quality › Descriptions, and nothing shows with Quality off", () => {
  const rewrites = (pendingRewrites: number | null) =>
    attention({ pendingRewrites }).items.find((item) => item.key === "rewrites");
  assert.deepEqual(rewrites(3)?.target, {
    kind: "link",
    href: "/project/p1/quality/descriptions",
  });
  assert.equal(rewrites(null), undefined);
});

function fix(id: string, issues: string[], apply: boolean, over: Partial<Fix> = {}): Fix {
  return {
    id,
    source: id.startsWith("rewrite:") ? "rewrite" : "craft",
    kind: id.startsWith("rewrite:") ? "rewrite" : "combine",
    issues: issues.map((issueId) => ({ id: issueId })),
    aliases: [],
    actions: { apply },
    subject: { tools: [], tasks: [], topics: [] },
    ...over,
  } as unknown as Fix;
}

test("with the fixes read, an issue opens its fix and the updates count what Fixes can apply", () => {
  const fixes: FixesSlice = {
    open: [fix("craft:c1", ["a"], false), fix("rewrite:r1", [], true), fix("rewrite:r2", [], true)],
    applied: [],
    rewritesOn: true,
  };
  const { items } = attention({
    health: { signals: readyHealth().signals.slice(0, 1), lockedCount: 0 },
    pendingRewrites: 9,
    fixes,
  });
  assert.deepEqual(items.find((item) => item.key === "issue:a")?.target, {
    kind: "link",
    href: "/project/p1/improvement/fixes?peek=craft%3Ac1",
  });
  assert.equal(items.find((item) => item.key === "rewrites")?.figure.value, "2");
  // Rewrites off the plan are not ready to apply, whatever Quality has pending.
  const offPlan = attention({ pendingRewrites: 9, fixes: { ...fixes, rewritesOn: false } });
  assert.equal(
    offPlan.items.some((item) => item.key === "rewrites"),
    false,
  );
});

test("a description update opens on Quality › Descriptions; any other fix on Fixes", () => {
  assert.equal(
    fixTarget("p1", fix("rewrite:r1", [], true)),
    "/project/p1/quality/descriptions?peek=rewrite%3Ar1",
  );
  const drafted = fix("craft:c2", [], false, {
    kind: "rewrite",
    subject: {
      tools: [{ id: "lookup_order", label: "lookup_order", href: "" }],
      tasks: [],
      topics: [],
    },
  });
  assert.equal(fixTarget("p1", drafted), "/project/p1/quality/descriptions?tool=lookup_order");
  assert.equal(
    fixTarget("p1", fix("craft:c3", [], false)),
    "/project/p1/improvement/fixes?peek=craft%3Ac3",
  );
});

test("an issue's panel keeps the window and lands on its row", () => {
  assert.equal(
    issuePanelHref("/project/p1/health", "abc"),
    "/project/p1/health?peek=issue%3Aabc#signal-abc",
  );
  assert.equal(
    issuePanelHref("/project/p1/health?days=30", "abc"),
    "/project/p1/health?days=30&peek=issue%3Aabc#signal-abc",
  );
});

test("SDK activity adds the days up, and a day without events is zero", () => {
  const previous = { searches: 250, toolCalls: 240, skillRuns: 10 };
  const sdkDays = [
    { day: "2026-10-13", searches: 100, toolCalls: 90, skillRuns: 0 },
    { day: "2026-10-15", searches: 200, toolCalls: 200, skillRuns: 20 },
  ];
  assert.deepEqual(overviewSdk({ sdkDays, sdkPrevious: previous }, DAYS), {
    current: { searches: 300, toolCalls: 290, skillRuns: 20 },
    previous,
    days: [
      { searches: 100, toolCalls: 90, skillRuns: 0 },
      { searches: 0, toolCalls: 0, skillRuns: 0 },
      { searches: 200, toolCalls: 200, skillRuns: 20 },
    ],
  });
  assert.equal(overviewSdk({ sdkDays: null, sdkPrevious: previous }, DAYS), null);
});
