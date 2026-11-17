// The runner only picks up `.ts`, so views are built with createElement.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionPanelBody } from "@/components/console/traces-sessions/SessionPanel";
import {
  SessionsView,
  type SessionsViewProps,
} from "@/components/console/traces-sessions/SessionsView";
import { TracesFrame } from "@/components/console/traces-sessions/TracesFrame";
import type { RunSummaryResult } from "@/lib/synthesis/traces/v2/run-summary-route";
import type { SessionRow } from "@/lib/synthesis/traces-sessions/sessions";

/** RC-313: the Sessions tab, rendered as the app renders it. */

const PROJECT = "6b64f504-f84f-447a-afe4-fb84054735fb";
const PATH = `/project/${PROJECT}/traces`;

function inRouter(search: string, children: ReactNode): ReactElement {
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
      { value: PATH },
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

function row(id: string, lastActivityAt: string, overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id,
    kind: "session",
    sessionId: id,
    traceIds: ["a".repeat(32)],
    ask: `Ask of ${id}`,
    intent: null,
    turns: 3,
    startedAt: lastActivityAt,
    lastActivityAt,
    durationMs: 64_000,
    failed: false,
    tools: ["find_booking"],
    costUsd: 0.0213,
    tokens: 4_560,
    experiment: null,
    href: `/project/${PROJECT}/sessions/${id}`,
    ...overrides,
  };
}

const ROWS: SessionRow[] = [
  row("s-3", "2026-11-03T09:00:00.000Z", {
    failed: true,
    experiment: { name: "ranker-v2", arm: "ratel" },
  }),
  row("s-2", "2026-11-03T08:00:00.000Z"),
  row("b".repeat(32), "2026-11-02T17:00:00.000Z", {
    kind: "run",
    sessionId: null,
    ask: null,
    turns: 1,
    href: `/project/${PROJECT}/traces/${"b".repeat(32)}`,
  }),
];

function render(search: string, props: Partial<SessionsViewProps> = {}): string {
  return renderToStaticMarkup(
    inRouter(
      search,
      createElement(
        TracesFrame,
        { enabled: true },
        createElement(SessionsView, {
          projectId: PROJECT,
          filter: "all",
          rows: ROWS,
          nextCursor: null,
          empty: null,
          experiment: null,
          ...props,
        }),
      ),
    ),
  );
}

test("the first tab is Sessions, and rows read by day: the ask, Failed, turns, time and start", () => {
  const html = render("");
  assert.match(text(html), /Sessions Spans Logs/);
  assert.doesNotMatch(text(html), /\bRuns\b Spans/);
  assert.doesNotMatch(
    html,
    /aria-label="Time window/,
    "no timeframe on the list: the summary header holds it",
  );
  const days = [...html.matchAll(/data-day="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(days, ["2026-11-03", "2026-11-02"]);
  assert.match(text(html), /Tuesday 3 November .*Ask of s-3 Failed 3 1\D+min\D+4\D+s 09:00/);
  assert.match(text(html), /Monday 2 November .*Run bbbbbbbb/);
  assert.match(html, /data-title-source="id"/, "a run with no ask reads as what it is");
});

test("Load more shows while there is a next page, and the end says so", () => {
  const more = render("", { nextCursor: "c1" });
  assert.match(more, /data-load-more[^>]*>Load more</);
  assert.doesNotMatch(more, /data-sessions-end/);
  const end = render("");
  assert.doesNotMatch(end, /data-load-more/);
  assert.match(text(end), /That is every session\./);
});

test("the filter is All or Failed, with no counts and no To check; Failed follows the URL", () => {
  const html = render("?show=failed", {
    filter: "failed",
    rows: ROWS.filter((candidate) => candidate.failed),
  });
  assert.match(text(html), /All Failed/);
  assert.doesNotMatch(text(html), /To check/);
  assert.doesNotMatch(text(html), /All \d/, "no counts that need a whole window");
  assert.match(html, /aria-pressed="true"[^>]*>(?:(?!<\/button>)[\s\S])*data-filter="failed"/);
  assert.match(text(html), /That is every failed session\./);
  const none = render("?show=failed", { filter: "failed", rows: [], empty: "no-failed" });
  assert.match(text(none), /No failed sessions/);
});

test("text off: a session reads as its intent; tools, tokens and cost only when toggled on", () => {
  const rows = [row("s-1", "2026-11-03T09:00:00.000Z", { ask: null, intent: "Seat change" })];
  const hidden = text(render("", { rows }));
  assert.match(hidden, /Seat change/);
  assert.doesNotMatch(hidden, /find_booking|4,560/);
  const shown = text(render("?columns=tools,tokens,cost", { rows }));
  assert.match(shown, /Tools Tokens Cost Time Started/);
  assert.match(shown, /find_booking 4,560 \$0\.02/);
});

test("a row of the running search experiment carries a small label", () => {
  const html = render("", { experiment: { name: "ranker-v2", href: "/x" } });
  assert.equal((html.match(/data-row-experiment/g) ?? []).length, 1);
  assert.match(html, /data-experiment-label/);
});

test("the panel: a short chat preview and Open session replay; a run opens its full trace", () => {
  const result: RunSummaryResult = {
    ok: true,
    summary: { ask: "Can I move to an aisle seat?", answer: "Done, 14C.", contentCaptured: true },
  } as RunSummaryResult;
  const session = renderToStaticMarkup(
    createElement(SessionPanelBody, { row: ROWS[0]!, result, onRetry: null }),
  );
  assert.match(session, /data-role="user"[^>]*>Can I move to an aisle seat\?/);
  assert.match(session, /data-role="assistant"[^>]*>Done, 14C\./);
  assert.match(
    session,
    new RegExp(`<a [^>]*href="/project/${PROJECT}/sessions/s-3"[^>]*>Open session replay`),
  );
  assert.match(session, /data-open-replay/);
  assert.match(text(session), /This session failed/);
  // The list read the ask even when the run summary says text was not captured.
  const uncaptured = {
    ok: true,
    summary: { ask: null, answer: null, contentCaptured: false },
  } as unknown as RunSummaryResult;
  assert.match(
    renderToStaticMarkup(
      createElement(SessionPanelBody, { row: ROWS[0]!, result: uncaptured, onRetry: null }),
    ),
    /data-role="user"[^>]*>Ask of s-3/,
  );
  const run = renderToStaticMarkup(
    createElement(SessionPanelBody, { row: ROWS[2]!, result: undefined, onRetry: null }),
  );
  assert.match(run, /Open full trace/);
  assert.match(run, /aria-busy="true"/, "the preview loads");
  const noRun = renderToStaticMarkup(
    createElement(SessionPanelBody, {
      row: { ...ROWS[1]!, traceIds: [] },
      result: null,
      onRetry: null,
    }),
  );
  assert.match(text(noRun), /no run to preview/);
});

// Owned (ADR-0030): the switch is FF_TRACES_SESSIONS, read in the owned page.
test("switch off renders RunsPageV2; switch on renders the Sessions page", () => {
  const source = readFileSync(
    new URL("../../../app/(console)/project/[projectId]/traces/(tabs)/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /const sessions = !viewsV3 && tracesSessionsEnabled\(\)/);
  assert.match(source, /sessions \?\s*\(\s*<SessionsPage[\s\S]*\) : \(\s*<RunsPageV2/);
});
