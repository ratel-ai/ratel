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
import { RunsTable } from "@/components/console/traces/RunsTable";
import { TraceSessionBar } from "@/components/console/traces/TraceSessionBar";
import { TracesHeader } from "@/components/console/traces/TracesHeader";
import {
  SessionListPanelBody,
  SessionListTable,
} from "@/components/console/traces-sessions/SessionListView";
import { TracesSessionsProvider } from "@/components/console/traces-sessions/sessions-context";
import type { RunRow } from "@/lib/synthesis/traces/v2/runs";
import type { SessionListRow } from "@/lib/synthesis/traces/v2/sessions-list";

/** RC-472: Traces lists turns and has a Sessions tab; a turn's trace links to its session. */

const PROJECT = "6b64f504-f84f-447a-afe4-fb84054735fb";
const ROOT = `/project/${PROJECT}/traces`;

function inRouter(pathname: string, children: ReactNode): ReactElement {
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
      { value: pathname },
      createElement(SearchParamsContext.Provider, { value: new URLSearchParams("") }, children),
    ),
  );
}

function tabs(sessions: boolean): string[] {
  const header = createElement(TracesHeader, {
    projectId: PROJECT,
    search: "",
    timeWindow: null,
    onSearchChange: () => {},
  });
  // The provider holds no hooks, so it is called directly with its children.
  const html = renderToStaticMarkup(
    inRouter(ROOT, sessions ? TracesSessionsProvider({ children: header }) : header),
  );
  return [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([^<]+)</g)].map(
    ([, href, label]) => `${label} ${href.replace(ROOT, "") || "/"}`,
  );
}

test("the tabs are Sessions (first), Turns, Spans and Logs, with cloud-traces-sessions on or off (RC-503)", () => {
  assert.deepEqual(tabs(false), ["Sessions /", "Turns /turns", "Spans /spans", "Logs /logs"]);
  assert.deepEqual(tabs(true), ["Sessions /", "Turns /turns", "Spans /spans", "Logs /logs"]);
});

test("a turn's trace says which session it is part of and links each turn to its own trace", () => {
  const html = renderToStaticMarkup(
    createElement(TraceSessionBar, {
      projectId: PROJECT,
      session: {
        sessionId: "s1",
        title: "Book a flight to Lisbon",
        turnIndex: 2,
        turns: [
          { turnIndex: 1, ask: "Book a flight to Lisbon", traceId: "a".repeat(32) },
          { turnIndex: 2, ask: null, traceId: "b".repeat(32) },
          { turnIndex: 3, ask: null, traceId: null },
        ],
      },
    }),
  );
  assert.match(html, new RegExp(`data-part-of-session[^>]*href="/project/${PROJECT}/sessions/s1"`));
  assert.match(html, /Part of session ·.*Book a flight to Lisbon/);
  assert.match(html, new RegExp(`data-turn="1"[^>]*href="${ROOT}/${"a".repeat(32)}"`));
  assert.match(html, /aria-current="page"[^>]*data-turn="2"/);
  // A turn with no trace opens the session's Trace view at that turn.
  assert.match(
    html,
    new RegExp(`data-turn="3"[^>]*href="/project/${PROJECT}/sessions/s1\\?view=trace&amp;turn=3"`),
  );
});

test("a session of one turn shows only the link, no picker", () => {
  const html = renderToStaticMarkup(
    createElement(TraceSessionBar, {
      projectId: PROJECT,
      session: {
        sessionId: "s1",
        title: "Untitled session · s1",
        turnIndex: 1,
        turns: [{ turnIndex: 1, ask: null, traceId: "a".repeat(32) }],
      },
    }),
  );
  assert.match(html, /data-part-of-session/);
  assert.doesNotMatch(html, /data-turn-picker/);
});

// RC-503: Sessions and Turns share one table layout, the ID column first; the session Panel shows every turn.

const SESSION: SessionListRow = {
  id: "session-0123456789",
  status: "failed",
  firstMessage: "Where is order 1234?",
  lastTurn: "Refund it",
  turns: 2,
  startedAt: "2026-11-02T09:00:00.000Z",
  lastActivityAt: "2026-11-02T09:00:10.100Z",
  durationMs: 10_100,
  tokens: 45,
  costUsd: 0.03,
  traceIds: [],
  href: `/project/${PROJECT}/sessions/session-0123456789`,
};

function headers(html: string): string[] {
  return [...html.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map(([, cell]) =>
    cell!.replace(/<[^>]+>/g, "").trim(),
  );
}

test("the Sessions table puts the ID first, then status, first message, last turn, turns, duration, started, last update, tokens and cost", () => {
  const html = renderToStaticMarkup(
    inRouter(
      ROOT,
      createElement(SessionListTable, {
        rows: [SESSION],
        now: "2026-11-02T10:00:00.000Z",
        openId: null,
        onOpen: () => {},
      }),
    ),
  );
  assert.deepEqual(headers(html), [
    "ID",
    "Status",
    "First message",
    "Last turn",
    "Turns",
    "Duration",
    "Started",
    "Last update",
    "Tokens",
    "Cost",
  ]);
  assert.match(html, /data-row-id="session-0123456789"[^>]*>session-…/);
  assert.match(html, /Failed/);
  assert.match(html, /Where is order 1234\?/);
  assert.match(html, /Refund it/);
});

test("the Turns table starts with the same ID column as Sessions", () => {
  const row: RunRow = {
    id: "abcdef0123456789abcdef0123456789",
    status: "completed",
    title: "Where is order 1234?",
    titleIsAsk: true,
    startedAt: "2026-11-02T09:00:00.000Z",
    durationMs: 100,
    tools: [],
    tokens: 1,
    costUsd: 0,
    spanCount: 1,
    errorCount: 0,
    experiment: null,
    variant: null,
  };
  const table = createElement(RunsTable, {
    rows: [row],
    now: "2026-11-02T10:00:00.000Z",
    pathname: ROOT,
    search: "",
    sort: { id: "started", direction: "desc" },
    showExperiment: false,
    openId: null,
    onOpen: () => {},
    picked: [],
    onTogglePick: () => {},
  });
  const html = headers(renderToStaticMarkup(inRouter(ROOT, table)));
  assert.equal(html[0], "ID");
  assert.equal(html[3], "Turn");
});

test("the session Panel shows every turn of the session as chat, each linking to its trace", () => {
  const work = { actions: 1, tookMs: 1000, problems: 0, label: "1 action · 1 s" };
  const html = renderToStaticMarkup(
    inRouter(
      ROOT,
      createElement(SessionListPanelBody, {
        projectId: PROJECT,
        row: SESSION,
        onRetry: () => {},
        result: {
          ok: true,
          chat: {
            textOff: false,
            turns: [
              {
                turnIndex: 1,
                ask: "Where is order 1234?",
                reply: "It shipped yesterday.",
                startedAt: "2026-11-02T09:00:00.000Z",
                endedAt: "2026-11-02T09:00:01.000Z",
                work,
                traceId: "a".repeat(32),
              },
              {
                turnIndex: 2,
                ask: "Refund it",
                reply: "Refunded.",
                startedAt: "2026-11-02T09:00:10.000Z",
                endedAt: "2026-11-02T09:00:10.100Z",
                work,
                traceId: null,
              },
            ],
          },
        },
      }),
    ),
  );
  assert.equal(html.match(/data-chat-bubble="person"/g)?.length, 2);
  assert.equal(html.match(/data-chat-bubble="agent"/g)?.length, 2);
  for (const text of ["Where is order 1234?", "It shipped yesterday.", "Refund it", "Refunded."])
    assert.equal(html.split(text).length - 1, 1, text);
  assert.match(html, new RegExp(`href="${ROOT}/${"a".repeat(32)}"[^>]*>Open turn 1`));
  assert.match(html, /href="[^"]*sessions\/session-0123456789[^"]*"[^>]*>Open turn 2/);
});
