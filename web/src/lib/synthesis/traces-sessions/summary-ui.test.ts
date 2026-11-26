// The runner only picks up `.ts`, so views are built with createElement.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LogsView } from "@/components/console/traces/LogsView";
import { SpansView } from "@/components/console/traces/SpansView";
import { MINI_VOLUME_HEIGHT } from "@/components/console/traces-sessions/MiniVolume";
import { SessionListView } from "@/components/console/traces-sessions/SessionListView";
import {
  type TabSummaryState,
  TabSummaryView,
} from "@/components/console/traces-sessions/TabSummary";
import { EMPTY_TRACE_FACETS } from "@/lib/synthesis/traces/queries";
import { buildVolumeModel } from "@/lib/synthesis/traces/v2/volume";
import { TRACES_WINDOWS, type TracesWindow } from "./timeframe";

/** RC-312, RC-331: the summary inside each Traces tab, rendered as the app renders it. */

const PROJECT = "6b64f504-f84f-447a-afe4-fb84054735fb";
const NOW = "2026-11-08T10:30:00.000Z";
const TIME_WINDOW = {
  preset: "7d" as const,
  from: "2026-11-02",
  to: "2026-11-08",
  today: "2026-11-08",
};
const VOLUME = buildVolumeModel({
  from: "2026-11-08",
  to: "2026-11-08",
  points: [
    { day: "2026-11-08", hour: 9, count: 40, errorCount: 3 },
    { day: "2026-11-08", hour: 10, count: 12, errorCount: 0 },
  ],
});

function inRouter(path: string, search: string, children: ReactNode): ReactElement {
  const router = {
    push: () => {},
    replace: () => {},
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  };
  return createElement(
    AppRouterContext.Provider,
    { value: router as never },
    createElement(
      PathnameContext.Provider,
      { value: path },
      createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) }, children),
    ),
  );
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function summary(state: TabSummaryState): string {
  return renderToStaticMarkup(createElement(TabSummaryView, { state, onWindowChange: () => {} }));
}

function ok(tab: "sessions" | "spans" | "logs", window: TracesWindow = "7d"): TabSummaryState {
  if (tab === "sessions")
    return {
      status: "ok",
      tab,
      window,
      sessions: 1_204,
      failed: 7,
      typicalDurationMs: 6_200,
      costUsd: 12.5,
      volume: VOLUME,
    };
  if (tab === "spans") {
    return {
      status: "ok",
      tab,
      window,
      spans: 9_870,
      errors: 12,
      p50DurationMs: 120,
      p95DurationMs: 2_400,
      kinds: [
        { kind: "Internal", count: 7_000 },
        { kind: "Client", count: 2_800 },
        { kind: "Server", count: 60 },
        { kind: "Producer", count: 10 },
      ],
      volume: VOLUME,
    };
  }
  return {
    status: "ok",
    tab,
    window,
    logs: 60,
    errors: 4,
    levels: [
      { level: "info", count: 45 },
      { level: "warn", count: 11 },
      { level: "error", count: 4 },
    ],
    volume: VOLUME,
  };
}

const VIEWS = {
  sessions: () =>
    createElement(SessionListView, {
      projectId: PROJECT,
      filter: "all",
      rows: [],
      nextCursor: null,
      now: NOW,
      empty: null,
      noTelemetry: null,
    }),
  spans: () =>
    createElement(SpansView, {
      projectId: PROJECT,
      now: NOW,
      timeWindow: TIME_WINDOW,
      facets: EMPTY_TRACE_FACETS,
      groupBy: null,
      spans: [],
      operations: [],
      sort: { id: "started", direction: "desc" },
      nextCursor: null,
      paged: false,
      empty: null,
      noTelemetry: null,
      latestAt: null,
      widerPreset: null,
    }),
  logs: () =>
    createElement(LogsView, {
      projectId: PROJECT,
      now: NOW,
      timeWindow: TIME_WINDOW,
      logs: [],
      experiments: [],
      nextCursor: null,
      paged: false,
      filtered: false,
    }),
};

function tab(name: keyof typeof VIEWS): string {
  const path = `/project/${PROJECT}/traces${name === "sessions" ? "" : `/${name}`}`;
  return renderToStaticMarkup(inRouter(path, "?window=30d", VIEWS[name]()));
}

test("each tab's summary shows each timeframe, picked, with only that tab's numbers", () => {
  for (const window of TRACES_WINDOWS) {
    const html = summary(ok("sessions", window));
    assert.match(html, new RegExp(`data-tab-summary="sessions" data-window="${window}"`));
    assert.match(text(html), /24 hours 7 days 30 days/, "the three timeframes");
    assert.equal(
      html.match(/aria-pressed="true"[^>]*>([^<]*)/)?.[1],
      { "24h": "24 hours", "7d": "7 days", "30d": "30 days" }[window],
    );
  }
  assert.match(
    text(summary(ok("sessions"))),
    /Sessions 1,204 Failed 7 Typical duration 6(\.\d)? s Cost \$12\.50/,
  );
  const spans = text(summary(ok("spans")));
  assert.match(
    spans,
    /Spans 9,870 Errors 12 p50 120 ms p95 2(\.\d)? s By kind Internal 7,000 Client 2,800 Server 60 \+1 more/,
  );
  assert.doesNotMatch(spans, /Sessions|Cost|Typical/);
  const logs = text(summary(ok("logs")));
  assert.match(logs, /Logs 60 Errors 4 By level info 45 warn 11 error 4/);
  assert.doesNotMatch(logs, /Spans|Sessions|p95/);
});

test("the volume chart is tall, in the data color, with start and end labels and a readout", () => {
  for (const name of ["sessions", "spans", "logs"] as const) {
    const html = summary(ok(name));
    assert.match(html, /data-mini-volume/);
    assert.match(html, new RegExp(`<svg[^>]*height="${MINI_VOLUME_HEIGHT}"`));
    assert.ok(MINI_VOLUME_HEIGHT >= 48 && MINI_VOLUME_HEIGHT <= 64);
    assert.match(html, /fill="var\(--ds-chart-1\)"/, "bars in the data color");
    assert.match(html, /fill="var\(--ds-danger\)"/, "errors in red");
    assert.match(
      html,
      /data-volume-axis[^>]*><span>Nov 8 00:00<\/span><span>Nov 8 23:00<\/span>/,
      "start and end labels",
    );
    assert.match(
      text(html),
      new RegExp(`${name.charAt(0).toUpperCase()}${name.slice(1)} over time max 40`),
      "the readout, before a bar is hovered",
    );
    assert.match(
      html,
      /aria-label="52 [a-z]+, 3 (failed|errors), from Nov 8 00:00 to Nov 8 23:00"/,
    );
  }
});

test("an empty timeframe's chart says there is nothing, with no scale", () => {
  const empty = buildVolumeModel({ from: "2026-11-08", to: "2026-11-08", points: [] });
  const html = text(
    summary({
      status: "ok",
      tab: "logs",
      window: "24h",
      logs: 0,
      errors: 0,
      levels: [],
      volume: empty,
    }),
  );
  assert.match(
    html,
    /Logs 0 Errors 0 By level – No logs in this timeframe Nov 8 00:00 Nov 8 23:00/,
  );
  assert.doesNotMatch(html, /max/);
});

test("while reading, and when the aggregate was too slow, the summary says so and is not an error page", () => {
  assert.match(
    text(summary({ status: "loading", tab: "spans", window: "30d" })),
    /Reading last 30 days/,
  );
  const slow = summary({ status: "unavailable", tab: "logs", window: "24h" });
  assert.match(slow, /data-summary-state="unavailable"/);
  assert.match(
    text(slow),
    /The numbers for last 24 hours are not available right now\. The list below still works\./,
  );
  assert.match(text(slow), /24 hours 7 days 30 days/, "the timeframe can still change");
});

test("each tab has its own summary under the tabs, with the URL's timeframe, and nothing above the tabs, with no flag (RC-591)", () => {
  for (const name of ["sessions", "spans", "logs"] as const) {
    const html = tab(name);
    assert.equal(html.match(/data-tab-summary="/g)?.length, 1, `${name}: one summary`);
    assert.match(html, new RegExp(`data-tab-summary="${name}" data-window="30d"`));
    const tabs = html.indexOf('aria-label="Traces sections"');
    assert.ok(tabs >= 0, `${name}: the tabs are drawn`);
    assert.ok(
      html.indexOf("data-tab-summary") > tabs,
      `${name}: the summary sits inside the tab, under the tabs`,
    );
  }
});
