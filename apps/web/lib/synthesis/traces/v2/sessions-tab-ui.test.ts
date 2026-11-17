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
import { TraceSessionBar } from "@/components/console/traces/TraceSessionBar";
import { TracesHeader } from "@/components/console/traces/TracesHeader";
import { TraceViewsV3Provider } from "@/components/console/traces/views-v3-context";
import { TracesSessionsProvider } from "@/components/console/traces-sessions/sessions-context";

/** RC-472: with `cloud-trace-views-v3`, Traces lists turns and has a Sessions tab; a turn's trace links to its session. */

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

function tabs(viewsV3: boolean, sessions: boolean): string[] {
  const header = createElement(TracesHeader, {
    projectId: PROJECT,
    search: "",
    timeWindow: null,
    onSearchChange: () => {},
  });
  // The providers hold no hooks, so they are called directly with their children.
  const framed = sessions ? TracesSessionsProvider({ children: header }) : header;
  const html = renderToStaticMarkup(
    inRouter(ROOT, TraceViewsV3Provider({ enabled: viewsV3, children: framed })),
  );
  return [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([^<]+)</g)].map(
    ([, href, label]) => `${label} ${href.replace(ROOT, "") || "/"}`,
  );
}

test("with the redesign, the tabs are Turns, Sessions, Spans and Logs, even with cloud-traces-sessions on", () => {
  assert.deepEqual(tabs(true, false), [
    "Turns /",
    "Sessions /sessions",
    "Spans /spans",
    "Logs /logs",
  ]);
  assert.deepEqual(tabs(true, true), [
    "Turns /",
    "Sessions /sessions",
    "Spans /spans",
    "Logs /logs",
  ]);
});

test("without the redesign, the tabs are as before", () => {
  assert.deepEqual(tabs(false, false), ["Runs /", "Spans /spans", "Logs /logs"]);
  assert.deepEqual(tabs(false, true), ["Sessions /", "Spans /spans", "Logs /logs"]);
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
