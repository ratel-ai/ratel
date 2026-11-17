import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTabSummary, type TabSummaryDeps } from "./summary";
import type {
  LogsAggregate,
  SessionsAggregate,
  SpansAggregate,
  TabAggregateOptions,
} from "./tab-aggregates";
import {
  logLevelOf,
  parseTracesTab,
  parseTracesWindow,
  tracesWindowRange,
  withTracesWindow,
} from "./timeframe";

/** RC-312, RC-331: the timeframe of each Traces tab's summary, and each tab's summary. */

const NOW = new Date("2026-11-08T10:30:00.000Z");
const SESSIONS: SessionsAggregate = {
  count: 42,
  failed: 3,
  p50DurationMs: 6_200,
  costUsd: 1.25,
  volume: [
    { day: "2026-11-08", hour: 9, count: 40, errorCount: 3 },
    { day: "2026-11-08", hour: 10, count: 2, errorCount: 0 },
  ],
};
const SPANS: SpansAggregate = {
  count: 900,
  errorCount: 12,
  p50DurationMs: 120,
  p95DurationMs: 2_400,
  kinds: [
    { kind: 1, count: 700 },
    { kind: 3, count: 200 },
  ],
  volume: [{ day: "2026-11-08", hour: 9, count: 900, errorCount: 12 }],
};
const LOGS: LogsAggregate = {
  count: 60,
  severities: [
    { severityNumber: 9, count: 40 },
    { severityNumber: 10, count: 5 },
    { severityNumber: 13, count: 10 },
    { severityNumber: 17, count: 4 },
    { severityNumber: 0, count: 1 },
  ],
  volume: [{ day: "2026-11-08", hour: 9, count: 60, errorCount: 4 }],
};
const quietDeps = { logError: () => {}, reportServerException: () => {} };

test("parseTracesWindow keeps 24h, 7d and 30d and falls back to 7d", () => {
  assert.equal(parseTracesWindow("24h"), "24h");
  assert.equal(parseTracesWindow("30d"), "30d");
  assert.equal(parseTracesWindow(["7d", "30d"]), "7d", "a repeated param reads as its first value");
  assert.equal(parseTracesWindow("3m"), "7d");
  assert.equal(parseTracesWindow(undefined), "7d");
});

test("tracesWindowRange ends now and reaches back the window's length", () => {
  assert.deepEqual(tracesWindowRange("24h", NOW), {
    since: new Date("2026-11-07T10:30:00.000Z"),
    until: NOW,
    from: "2026-11-07",
    to: "2026-11-08",
  });
  assert.equal(tracesWindowRange("30d", NOW).since.toISOString(), "2026-10-09T10:30:00.000Z");
});

test("withTracesWindow sets ?window= and leaves the rest of the query", () => {
  assert.equal(withTracesWindow("?show=failed", "24h"), "?show=failed&window=24h");
  assert.equal(
    withTracesWindow("?window=24h&show=failed", "7d"),
    "?show=failed",
    "the default is not written",
  );
});

test("parseTracesTab keeps sessions, spans and logs and falls back to sessions", () => {
  assert.equal(parseTracesTab("spans"), "spans");
  assert.equal(parseTracesTab(["logs", "spans"]), "logs");
  assert.equal(parseTracesTab("runs"), "sessions");
  assert.equal(parseTracesTab(null), "sessions");
});

test("logLevelOf reads the OTel severity bands", () => {
  assert.deepEqual([1, 4, 5, 9, 12, 13, 17, 20, 21, 24].map(logLevelOf), [
    "trace",
    "trace",
    "debug",
    "info",
    "info",
    "warn",
    "error",
    "error",
    "fatal",
    "fatal",
  ]);
  assert.deepEqual([0, 25, -1].map(logLevelOf), ["unspecified", "unspecified", "unspecified"]);
});

test("each tab's summary reads only its own aggregate, for each timeframe", async () => {
  for (const window of ["24h", "7d", "30d"] as const) {
    const { deps, asked } = recording();
    const sessions = await loadTabSummary("p1", "sessions", window, deps);
    assert.deepEqual(
      asked.map((call) => call.tab),
      ["sessions"],
    );
    assert.equal(sessions.status, "ok");
    if (sessions.status !== "ok" || sessions.tab !== "sessions") continue;
    assert.deepEqual(
      {
        window: sessions.window,
        sessions: sessions.sessions,
        failed: sessions.failed,
        typicalDurationMs: sessions.typicalDurationMs,
        costUsd: sessions.costUsd,
      },
      { window, sessions: 42, failed: 3, typicalDurationMs: 6_200, costUsd: 1.25 },
    );
    assert.equal(sessions.volume.totals.count, 42);
    const since = tracesWindowRange(window, NOW).since.getTime();
    assert.ok(
      sessions.volume.buckets.every(
        (bucket) => bucket.endMs > since && bucket.startMs < NOW.getTime(),
      ),
      "the chart draws only the timeframe",
    );
    if (window === "24h")
      assert.equal(
        sessions.volume.buckets.length,
        25,
        "24 hours by the hour, the current hour included",
      );
    assert.deepEqual(asked[0]?.projectId, "p1");
    assert.deepEqual(asked[0]?.options.since, tracesWindowRange(window, NOW).since);
    assert.equal(asked[0]?.options.volumeBucket, window === "30d" ? "day" : "hour");
  }
});

test("the Spans summary has spans, errors, p50/p95 and kinds by name", async () => {
  const { deps, asked } = recording();
  const summary = await loadTabSummary("p1", "spans", "24h", deps);
  assert.deepEqual(
    asked.map((call) => call.tab),
    ["spans"],
  );
  assert.ok(summary.status === "ok" && summary.tab === "spans");
  assert.deepEqual(
    {
      spans: summary.spans,
      errors: summary.errors,
      p50: summary.p50DurationMs,
      p95: summary.p95DurationMs,
      kinds: summary.kinds,
    },
    {
      spans: 900,
      errors: 12,
      p50: 120,
      p95: 2_400,
      kinds: [
        { kind: "Internal", count: 700 },
        { kind: "Client", count: 200 },
      ],
    },
  );
  assert.equal(summary.volume.totals.errorCount, 12);
});

test("the Logs summary groups severities into levels and counts errors", async () => {
  const { deps, asked } = recording();
  const summary = await loadTabSummary("p1", "logs", "7d", deps);
  assert.deepEqual(
    asked.map((call) => call.tab),
    ["logs"],
  );
  assert.ok(summary.status === "ok" && summary.tab === "logs");
  assert.equal(summary.logs, 60);
  assert.equal(summary.errors, 4);
  assert.deepEqual(summary.levels, [
    { level: "info", count: 45 },
    { level: "warn", count: 10 },
    { level: "error", count: 4 },
    { level: "unspecified", count: 1 },
  ]);
});

test("a slow or failing aggregate degrades to the tab's unavailable state, never throws", async () => {
  for (const tab of ["sessions", "spans", "logs"] as const) {
    const errors: string[] = [];
    const failing = async (): Promise<never> => {
      throw new Error("canceling statement due to statement timeout");
    };
    const summary = await loadTabSummary("p1", tab, "30d", {
      now: () => NOW,
      sessions: failing,
      spans: failing,
      logs: failing,
      logError: (message) => errors.push(message),
      reportServerException: () => {},
    });
    assert.deepEqual(summary, { status: "unavailable", tab, window: "30d" });
    assert.equal(errors.length, 1, "the failure is logged, not swallowed");
  }
});

test("an empty window has no typical duration and no percentiles", async () => {
  const empty = {
    count: 0,
    failed: 0,
    errorCount: 0,
    p50DurationMs: null,
    p95DurationMs: null,
    costUsd: 0,
    kinds: [],
    severities: [],
    volume: [],
  };
  const deps: TabSummaryDeps = {
    now: () => NOW,
    sessions: async () => empty,
    spans: async () => empty,
    logs: async () => empty,
    ...quietDeps,
  };
  const sessions = await loadTabSummary("p1", "sessions", "24h", deps);
  assert.equal(
    sessions.status === "ok" && sessions.tab === "sessions" && sessions.typicalDurationMs,
    null,
  );
  const spans = await loadTabSummary("p1", "spans", "24h", deps);
  assert.deepEqual(
    spans.status === "ok" && spans.tab === "spans" && [spans.p50DurationMs, spans.kinds],
    [null, []],
  );
});

function recording(): {
  deps: TabSummaryDeps;
  asked: { tab: string; projectId: string; options: TabAggregateOptions }[];
} {
  const asked: { tab: string; projectId: string; options: TabAggregateOptions }[] = [];
  const deps: TabSummaryDeps = {
    now: () => NOW,
    sessions: async (projectId, options) => (
      asked.push({ tab: "sessions", projectId, options }), SESSIONS
    ),
    spans: async (projectId, options) => (asked.push({ tab: "spans", projectId, options }), SPANS),
    logs: async (projectId, options) => (asked.push({ tab: "logs", projectId, options }), LOGS),
    ...quietDeps,
  };
  return { deps, asked };
}
