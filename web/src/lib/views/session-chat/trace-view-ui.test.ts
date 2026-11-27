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
import { SessionChatView } from "@/components/console/session-chat/SessionChatView";
import {
  SessionTraceView,
  type SessionTraceViewProps,
  type TraceViewTurn,
} from "@/components/console/session-chat/SessionTraceView";
import type { OtelSpan } from "@/lib/ingest/otlp/schema";
import { buildRunSummary } from "@/lib/synthesis/traces/v2/run-summary";
import { buildTraceWaterfall } from "@/lib/synthesis/traces/waterfall";
import { buildSessionTimeline, type TimelineTurn } from "@/lib/views/session-replay/timeline";
import type { TraceViewProps } from "@/lib/views/traces/trace-view-types";
import { buildSessionChat } from "./model";

/** RC-314: the session replay's Trace view and its way in from a work line. */

const PROJECT = "p1";
const PATH = `/project/${PROJECT}/sessions/s1`;
const T0 = Date.parse("2026-10-02T13:43:00Z");
const TRACE_A = "a".repeat(32);
const TRACE_B = "b".repeat(32);

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

const TURNS: TraceViewTurn[] = [
  { turnIndex: 1, ask: "Can I move to an aisle seat?", traceIds: [TRACE_A] },
  { turnIndex: 2, ask: "And a meal?", traceIds: [TRACE_A, TRACE_B] },
  { turnIndex: 3, ask: "Thanks!", traceIds: [] },
];

function render(props: Partial<SessionTraceViewProps>): string {
  return renderToStaticMarkup(
    inRouter(
      "?view=trace",
      createElement(SessionTraceView, {
        projectId: PROJECT,
        sessionId: "s1",
        turns: TURNS,
        turnIndex: 1,
        traceId: TRACE_A,
        trace: traceProps(),
        ...props,
      }),
    ),
  );
}

test("the Trace view shows the chosen turn's full trace, inside the session page, with a turn picker", () => {
  const html = render({});
  assert.match(html, new RegExp(`data-trace-embedded="${TRACE_A}"`));
  assert.match(html, /Timeline/, "the existing waterfall tabs");
  assert.match(html, /agent\.run|capabilities\.search/, "the waterfall's spans");
  assert.doesNotMatch(html, /<h1/, "no second page header");
  assert.equal((html.match(/data-turn="/g) ?? []).length, 3);
  assert.match(html, /aria-current="page"[^>]*data-turn="1"|data-turn="1"[^>]*aria-current="page"/);
  assert.match(
    html,
    /href="\/project\/p1\/sessions\/s1\?view=trace&amp;turn=2"/,
    "each turn links to its trace",
  );
});

test("a turn with several runs lists them, the shown one current", () => {
  const html = render({ turnIndex: 2, traceId: TRACE_B, trace: traceProps({ traceId: TRACE_B }) });
  assert.match(html, /data-turn-runs/);
  assert.match(html, /2 traces in this turn/);
  assert.match(
    html,
    new RegExp(`href="/project/p1/sessions/s1\\?view=trace&amp;turn=2&amp;trace=${TRACE_A}"`),
  );
  assert.match(html, /aria-current="page"[^>]*>Trace 2 · bbbbbbbb/);
});

test("a turn without a trace says so", () => {
  const html = render({ turnIndex: 3, traceId: null, trace: null });
  assert.match(html, /data-no-trace="3"/);
  assert.match(html, /Turn 3 has no trace/);
  assert.match(html, /did not come with OpenTelemetry spans/);
  assert.doesNotMatch(html, /data-trace-embedded/);
  assert.doesNotMatch(html, /data-turn-runs/, "one run or none: no run list");
});

test("a work line's panel has Open full trace, to that turn's Trace view", () => {
  const at = (ms: number) => new Date(T0 + ms);
  const turns: TimelineTurn[] = [
    {
      id: "t1",
      startedAt: at(0),
      endedAt: at(5_000),
      endedBy: "next_turn",
      abandoned: false,
      detour: false,
      reSearchCount: 0,
      steps: [],
    },
    {
      id: "t2",
      startedAt: at(60_000),
      endedAt: at(64_000),
      endedBy: "idle",
      abandoned: false,
      detour: false,
      reSearchCount: 0,
      steps: [],
    },
  ];
  const timeline = buildSessionTimeline({
    sessionId: "s1",
    turns,
    modelCalls: [],
    selfCorrections: [],
  });
  const chat = buildSessionChat({ timeline, turns, texts: null });
  const html = renderToStaticMarkup(
    inRouter(
      "?peek=work:2",
      createElement(SessionChatView, { projectId: PROJECT, chat, settingsHref: "/x" }),
    ),
  );
  assert.match(
    html,
    /<a [^>]*data-open-full-trace="2" href="\/project\/p1\/sessions\/s1\?view=trace&amp;turn=2">(?:<[^>]+>)*Open full trace<\/a>/,
  );
});

function traceProps(overrides: Partial<TraceViewProps> = {}): TraceViewProps {
  const spans = [
    span({ spanId: "f7a1000000000011", parentSpanId: null, name: "agent.run", durationMs: 2_772 }),
    span({
      spanId: "f7a1000000000013",
      at: 1_000,
      name: "capabilities.search",
      spanClass: "ratel_search",
      durationMs: 41,
    }),
  ];
  const summary = buildRunSummary(spans, 0);
  return {
    projectId: PROJECT,
    traceId: TRACE_A,
    title: summary.title,
    service: "agent-demo",
    startedAt: summary.startedAt,
    status: summary.status,
    totals: summary.totals,
    waterfall: buildTraceWaterfall(spans),
    truncated: false,
    lifecycle: [],
    listHref: `/project/${PROJECT}/traces`,
    compareHref: `/project/${PROJECT}/traces?compare=${TRACE_A}`,
    initialTab: "timeline",
    initialSpanId: null,
    runtimeEventsRoot: null,
    ...overrides,
  };
}

function span(overrides: Partial<OtelSpan> & { spanId: string; at?: number }): OtelSpan {
  const { at = 0, ...rest } = overrides;
  const startedAt = new Date(T0 + at);
  const durationMs = rest.durationMs ?? 100;
  return {
    id: `00000000-0000-8000-8000-${rest.spanId.slice(-12)}`,
    projectId: PROJECT,
    receivedAt: startedAt,
    traceId: TRACE_A,
    eventId: null,
    sourceId: null,
    parentSpanId: "f7a1000000000011",
    name: "step",
    kind: 1,
    spanClass: "other",
    startedAt,
    endedAt: new Date(startedAt.getTime() + durationMs),
    durationMs,
    statusCode: 1,
    serviceName: "agent-demo",
    scopeName: null,
    operationName: null,
    providerName: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
    costUsd: null,
    searchOrigin: null,
    searchTarget: null,
    searchQuery: null,
    searchTopK: null,
    searchHitCount: null,
    experimentName: null,
    experimentArm: null,
    experimentRole: null,
    experimentAttrs: {},
    attributes: {},
    attrsTruncated: false,
    agentKey: null,
    agentSource: null,
    callerAgentKey: null,
    mcpServer: null,
    mcpServerSource: null,
    mcpRole: null,
    mcpSessionId: null,
    sessionId: null,
    endUserId: null,
    events: null,
    links: null,
    properties: null,
    ...rest,
  };
}
