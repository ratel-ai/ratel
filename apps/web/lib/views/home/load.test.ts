import assert from "node:assert/strict";
import { test } from "node:test";
import type { HealthPageModel, HealthTile } from "@/lib/readings/trace-signals/view";
import type { TraceAggregateSummary } from "@/lib/synthesis/traces/queries";
import type { Fix } from "@/lib/views/fixes/types";
import { pendingHealthModel } from "@/lib/views/health/page-model";
import { unavailableSelfCorrectionsCard } from "@/lib/views/health/self-corrections/card";
import { signal } from "@/lib/views/health/workflows-view-fixtures";
import { READ_FAILED } from "@/lib/views/home/glance";
import {
  assembleOverview,
  type FixesSlice,
  fixTarget,
  issuePanelHref,
  type OverviewReads,
} from "@/lib/views/home/load";
import type { TaskListModel } from "@/lib/views/tasks/model";

const PROJECT = { id: "p1", name: "Support bot", slug: "support-bot", isDemo: false };
const DAYS = ["2026-10-13", "2026-10-14", "2026-10-15"];
const LIMITS = {
  agentHealthSignalsShown: 1,
  agentHealthEvidenceTurns: 3,
  agentHealthWindowDays: 30,
};

function aggregate(overrides: Partial<TraceAggregateSummary> = {}): TraceAggregateSummary {
  return {
    count: 40,
    errorCount: 8,
    errorRate: 0.2,
    p50DurationMs: 900,
    p95DurationMs: 4_000,
    p99DurationMs: 6_000,
    costUsd: 1.5,
    totalTokens: 90_000,
    volume: [{ day: "2026-10-14", count: 40, errorCount: 8 }],
    ...overrides,
  };
}

function reads(overrides: Partial<OverviewReads> = {}): OverviewReads {
  return {
    traces: aggregate(),
    previous: aggregate({ count: 30 }),
    dailyTraces: [],
    recentRuns: [],
    runTasks: new Map(),
    telemetry: {
      hasEvents: true,
      hasSpans: true,
      latestEventAt: null,
      latestSpanAt: new Date("2026-10-15T10:00:00.000Z"),
    },
    dailyAggregates: [],
    health: null,
    healthLimits: LIMITS,
    healthWindow: 7,
    pendingRewrites: null,
    fixes: null,
    sdkDays: null,
    sdkPrevious: null,
    sdkLatestAt: null,
    intents: null,
    tasks: null,
    corrections: unavailableSelfCorrectionsCard("p1", 7),
    ...overrides,
  };
}

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

function assemble(overrides: Partial<OverviewReads> = {}) {
  return assembleOverview({ project: PROJECT, window: 7, days: DAYS, reads: reads(overrides) });
}

test("the window's runs fill the daily series and failing runs lead the list", () => {
  const overview = assemble({
    dailyTraces: [
      {
        day: "2026-10-14",
        traceCount: 40,
        errorTraceCount: 8,
        averageLatencyMs: 1_100,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 1.5,
      },
    ],
  });
  assert.deepEqual(overview.series, [0, 40, 0]);
  assert.deepEqual(overview.daily, {
    failedShare: [null, 0.2, null],
    duration: [null, 1_100, null],
    spend: [null, 1.5, null],
  });
  assert.equal(overview.attention.items[0]!.key, "errors");
  assert.deepEqual(overview.attention.items[0]!.target, {
    kind: "link",
    href: "/project/p1/traces?range=7d&errorOnly=1",
  });
  assert.equal(overview.lastEventAt?.toISOString(), "2026-10-15T10:00:00.000Z");
  assert.equal(overview.hasTelemetry, true);
});

test("a project that never sent anything gets the setup guide", () => {
  const overview = assemble({
    traces: aggregate({ count: 0, errorCount: 0, errorRate: 0, volume: [] }),
    telemetry: { hasEvents: false, hasSpans: false, latestEventAt: null, latestSpanAt: null },
  });
  assert.equal(overview.hasTelemetry, false);
});

test("a failed diagnostics read never passes for an empty project", () => {
  const overview = assemble({ traces: null, telemetry: null, dailyTraces: null });
  assert.equal(overview.hasTelemetry, true);
  assert.equal(overview.lastEventAt, null);
  assert.deepEqual(overview.series, [0, 0, 0]);
  assert.deepEqual(overview.daily.duration, [null, null, null]);
  assert.equal(overview.attention.items.length, 0, "no failure share without numbers");
});

test("Agent health adds its first try, its issues cut to the plan, each opening its panel", () => {
  const overview = assemble({ health: readyHealth(), healthWindow: 30 });
  assert.equal(overview.health?.href, "/project/p1/health?days=30");
  assert.equal(overview.health?.firstTry?.value, 0.7);
  const issues = overview.attention.items.filter((item) => item.key.startsWith("issue:"));
  // The plan shows one issue; the other is counted, not listed.
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0]!.target, {
    kind: "link",
    href: "/project/p1/health?days=30&peek=issue%3Aa#signal-a",
  });
  assert.equal(overview.attention.moreIssues, 1);
});

test("Agent health still collecting gives no first try", () => {
  const overview = assemble({ health: { ...readyHealth(), turns: 10 } });
  assert.equal(overview.health?.firstTry, null);
});

test("description updates ready open Quality › Descriptions, and nothing shows with Quality off", () => {
  const on = assemble({ pendingRewrites: 3 });
  const rewrites = on.attention.items.find((item) => item.key === "rewrites");
  assert.deepEqual(rewrites?.target, { kind: "link", href: "/project/p1/quality/descriptions" });
  const off = assemble({ pendingRewrites: null });
  assert.equal(
    off.attention.items.some((item) => item.key === "rewrites"),
    false,
  );
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
  const overview = assemble({
    health: {
      ...readyHealth(),
      signals: [signal("a", "error_loop", "tool", "upload", ["upload"])],
    },
    pendingRewrites: 9,
    fixes,
  });
  const issue = overview.attention.items.find((item) => item.key === "issue:a");
  assert.deepEqual(issue?.target, {
    kind: "link",
    href: "/project/p1/improvement/fixes?peek=craft%3Ac1",
  });
  const rewrites = overview.attention.items.find((item) => item.key === "rewrites");
  assert.equal(rewrites?.figure.value, "2");
  assert.equal(overview.glance.fixes.open, 3);
  assert.equal(overview.glance.fixes.descriptions, 2);
  // Rewrites off the plan are not ready to apply, whatever Quality has pending.
  const offPlan = assemble({
    pendingRewrites: 9,
    fixes: { ...fixes, open: [fixes.open[0]!], rewritesOn: false },
  });
  assert.equal(
    offPlan.attention.items.some((item) => item.key === "rewrites"),
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

test("a project that sends only SDK events is live, with each day's events", () => {
  const overview = assemble({
    traces: aggregate({ count: 0, errorCount: 0, errorRate: 0, volume: [] }),
    telemetry: { hasEvents: false, hasSpans: false, latestEventAt: null, latestSpanAt: null },
    sdkDays: [
      { day: "2026-10-13", searches: 100, toolCalls: 90, skillRuns: 0 },
      { day: "2026-10-15", searches: 200, toolCalls: 200, skillRuns: 20 },
    ],
    sdkPrevious: { searches: 250, toolCalls: 240, skillRuns: 10 },
    sdkLatestAt: new Date("2026-10-15T11:30:00.000Z"),
  });
  assert.equal(overview.hasTelemetry, true);
  assert.equal(overview.lastEventAt?.toISOString(), "2026-10-15T11:30:00.000Z");
  assert.deepEqual(overview.sdk, {
    current: { searches: 300, toolCalls: 290, skillRuns: 20 },
    previous: { searches: 250, toolCalls: 240, skillRuns: 10 },
    days: [
      { searches: 100, toolCalls: 90, skillRuns: 0 },
      { searches: 0, toolCalls: 0, skillRuns: 0 },
      { searches: 200, toolCalls: 200, skillRuns: 20 },
    ],
  });
});

test("the newest of spans, events and SDK events is the last event", () => {
  const overview = assemble({ sdkLatestAt: new Date("2026-10-01T00:00:00.000Z") });
  assert.equal(overview.lastEventAt?.toISOString(), "2026-10-15T10:00:00.000Z");
});

test("the tiles read intents, tasks, self-corrections and fixes, each failing on its own", () => {
  const tasks: TaskListModel = {
    state: "ready",
    blocked: null,
    windowDays: 30,
    readAt: null,
    stats: {
      tasks: 1,
      runsInTasks: 10,
      allRuns: 10,
      finishRate: 0.8,
      correctionsPer100: null,
      correctionsRecorded: false,
    },
    rows: [
      {
        id: "wf1",
        name: "Track a delivery",
        color: "chart-1",
        runs: 10,
        finishRate: 0.8,
      } as TaskListModel["rows"][number],
    ],
    unserved: { measured: false, asks: [], runs: 0 },
    readingSince: null,
    excludedRuns: 0,
  };
  const overview = assemble({
    intents: {
      topics: [{ id: "t1", turns: 60, answered: 10 }],
      names: new Map([["t1", "Equipment rental"]]),
    },
    tasks: { list: tasks, steps: [["a", "b"]] },
    fixes: null,
    // A run in a task the latest reading no longer has wears no pin.
    runTasks: new Map([
      ["trace-1", "wf1"],
      ["trace-2", "wf-gone"],
    ]),
  });
  assert.deepEqual(overview.runTasks, {
    "trace-1": {
      id: "wf1",
      name: "Track a delivery",
      slot: "chart-1",
      href: "/project/p1/health/tasks/wf1",
    },
  });
  assert.equal(overview.glance.intents.count, 1);
  assert.equal(overview.glance.tasks.weakest?.name, "Track a delivery");
  assert.equal(overview.glance.selfCorrections.state, "unavailable");
  assert.equal(overview.glance.fixes.state, "failed");
  // An intent mostly unanswered needs attention, and opens in its panel.
  const intent = overview.attention.items.find((item) => item.key === "intent:t1");
  assert.deepEqual(intent?.target, { kind: "link", href: "/project/p1/intents?peek=t1" });
  const failed = assemble({ intents: READ_FAILED, tasks: READ_FAILED });
  assert.equal(failed.glance.intents.state, "failed");
  assert.equal(failed.glance.tasks.state, "failed");
});
