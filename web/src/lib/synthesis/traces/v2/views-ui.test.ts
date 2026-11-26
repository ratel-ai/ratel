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
import { RunSummaryBody } from "@/components/console/traces/RunPanel";
import { RunsView, type RunsViewProps } from "@/components/console/traces/RunsView";
import { TraceView } from "@/components/console/traces/TraceView";
import { apiKeyCta, noApiKeyCta } from "@/lib/console/api-key-cta";
import type { OtelSpan } from "@/lib/ingest/otlp/schema";
import { EMPTY_TRACE_AGGREGATE, EMPTY_TRACE_FACETS } from "@/lib/synthesis/traces/queries";
import { buildTraceWaterfall } from "@/lib/synthesis/traces/waterfall";
import type { TraceViewProps } from "@/lib/views/traces/trace-view-types";
import { buildRunSummary } from "./run-summary";
import { type RunRow, runStats } from "./runs";
import { buildVolumeModel } from "./volume";

const PROJECT = "6b64f504-f84f-447a-afe4-fb84054735fb";

/** The project's onboarding key, as `loadApiKeyCta` reads it. */
const WITH_KEY = apiKeyCta(
  PROJECT,
  [
    {
      name: "Onboarding",
      keyPrefix: "rtl_abc",
      createdAt: new Date("2026-11-20T09:30:00Z"),
      revokedAt: null,
      expiresAt: null,
      scopes: ["*"],
    },
  ],
  new Date("2026-11-26T12:00:00Z"),
);
const TRACE_A = "a".repeat(32);
const TRACE_B = "b".repeat(32);
const NOW = "2026-10-15T12:00:00.000Z";

/** Mount a client view the way the app does: router, pathname and query in context. */
function inRouter(pathname: string, search: string, children: ReactNode): ReactElement {
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
      createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) }, children),
    ),
  );
}

function run(id: string, overrides: Partial<RunRow> = {}): RunRow {
  return {
    id,
    status: "completed",
    title: "support-agent",
    titleIsAsk: false,
    startedAt: "2026-10-09T12:00:35.578Z",
    durationMs: 1840,
    tools: [],
    tokens: 340,
    costUsd: 0.0123,
    spanCount: 3,
    errorCount: 0,
    experiment: null,
    variant: null,
    ...overrides,
  };
}

function runsProps(overrides: Partial<RunsViewProps> = {}): RunsViewProps {
  return {
    projectId: PROJECT,
    now: NOW,
    timeWindow: { preset: "7d", from: "2026-10-09", to: "2026-10-15", today: "2026-10-15" },
    rows: [
      run(TRACE_A, {
        status: "failed",
        errorCount: 1,
        tools: ["lookup_order", "search_docs", "refund", "notify"],
      }),
      run(TRACE_B, { title: "Where is order 1234?", titleIsAsk: true }),
    ],
    stats: runStats({
      ...EMPTY_TRACE_AGGREGATE,
      count: 60,
      errorCount: 2,
      errorRate: 2 / 60,
      p50DurationMs: 1840,
      p95DurationMs: 6120,
    }),
    volume: buildVolumeModel({
      from: "2026-10-09",
      to: "2026-10-15",
      points: [
        { day: "2026-10-09", hour: 11, count: 36, errorCount: 2 },
        { day: "2026-10-09", hour: 12, count: 24, errorCount: 0 },
      ],
    }),
    facets: { ...EMPTY_TRACE_FACETS, model: [{ value: "claude-sonnet", count: 60 }] },
    sort: { id: "started", direction: "desc" },
    nextCursor: null,
    paged: false,
    empty: null,
    latestRunAt: null,
    widerPreset: null,
    experiment: null,
    loadSummary: async () => ({ ok: false, message: "not in tests" }),
    ...overrides,
  };
}

function renderRuns(search = "", overrides: Partial<RunsViewProps> = {}): string {
  return renderToStaticMarkup(
    inRouter(
      `/project/${PROJECT}/traces/turns`,
      search,
      createElement(RunsView, runsProps(overrides)),
    ),
  );
}

test("the Runs page is one frame: a single h1, its tabs, one filter row, the numbers, the chart and the list", () => {
  const html = renderRuns("?range=7d");
  assert.equal(html.match(/<h1/g)?.length, 1);
  assert.match(html, /<h1[^>]*>Traces<\/h1>/);
  assert.match(html, /data-page="v2"/);
  assert.match(html, /<nav aria-label="Traces sections"/);
  assert.match(html, /<a[^>]*aria-current="page"[^>]*>Turns<\/a>/, "the Turns tab is current");
  assert.match(html, /href="\/project\/[^"]+\/traces\/spans\?range=7d"/, "tabs carry the window");
  assert.equal(html.match(/role="toolbar"/g)?.length, 1, "one filter row, not three");
  assert.match(html, /role="search"/);
  assert.equal(html.match(/<dt/g)?.length, 5, "five key numbers");
  // RC-752: the numbers and the chart sit in the Sessions tab's summary card.
  assert.match(
    html,
    /<section aria-label="Turns summary" data-tab-summary="turns" class="[^"]*rounded-lg border border-line bg-raised/,
  );
  assert.match(html, /data-mini-volume="true" aria-label="60 turns, 2 failed, from /);
  assert.match(
    html,
    /<dd class="text-xs text-fg-subtle tabular-nums">2 failed<\/dd>/,
    "a number's hint sits under it",
  );
  assert.match(html, /<caption class="sr-only">Turns<\/caption>/);
  assert.match(html, /aria-label="Time window: Last 7 days"/);
  assert.doesNotMatch(html, /uppercase/, "no tracked eyebrows");
  assert.doesNotMatch(html, /text-\[(?:9|10|11)px\]/, "nothing under 12px");
  assert.doesNotMatch(html, /\u2014/, "no em dashes");
});

test("a one-day window on today reads as Today; other custom windows show their days and a way back", () => {
  const today = renderRuns("?range=custom&from=2026-10-15&to=2026-10-15", {
    timeWindow: { preset: "custom", from: "2026-10-15", to: "2026-10-15", today: "2026-10-15" },
  });
  assert.match(today, /aria-label="Time window: Today \(UTC\)"/);
  assert.doesNotMatch(today, />Reset range</, "today is a window, not a zoom");
  const oneDay = renderRuns("?range=custom&from=2026-10-15&to=2026-10-15", {
    timeWindow: { preset: "custom", from: "2026-10-15", to: "2026-10-15", today: "2026-10-15" },
    volume: buildVolumeModel({
      from: "2026-10-15",
      to: "2026-10-15",
      points: [{ day: "2026-10-15", hour: 9, count: 4, errorCount: 0 }],
    }),
  });
  assert.equal(
    oneDay.includes('fill="transparent" class="cursor-pointer"'),
    false,
    "one UTC day has nothing narrower to select",
  );
  assert.equal(
    renderRuns("?range=7d").includes('fill="transparent" class="cursor-pointer"'),
    true,
    "a wider window zooms on a bar",
  );
  const zoomed = renderRuns("?range=custom&from=2026-10-09&to=2026-10-11", {
    timeWindow: { preset: "custom", from: "2026-10-09", to: "2026-10-11", today: "2026-10-15" },
  });
  assert.match(zoomed, /aria-label="Time window: Oct 9 to Oct 11"/);
  assert.match(zoomed, />Reset range</);
});

test("rows read as status words, the ask or the run's name, and up to three tools", () => {
  const html = renderRuns();
  assert.match(html, /Failed/);
  assert.match(html, /Completed/);
  assert.match(html, /Where is order 1234\?/);
  assert.match(html, /lookup_order/);
  assert.match(html, />\+1</, "the fourth tool is counted, not shown");
  assert.doesNotMatch(html, />notify</);
  assert.match(html, /aria-label="Pick support-agent to compare"/);
  assert.match(
    html,
    /role="checkbox"[^>]*tabindex="-1"|tabindex="-1"[^>]*role="checkbox"/,
    "the row is the tab stop, not its checkbox",
  );
  assert.doesNotMatch(html, /role="checkbox"[^>]*tabindex="0"|tabindex="0"[^>]*role="checkbox"/);
  assert.match(html, /<tr[^>]*aria-keyshortcuts="x"/, "x on a focused row picks it");
  assert.match(html, /<time dateTime="2026-10-09T12:00:35.578Z"[^>]*>6\u00a0days ago<\/time>/);
  assert.doesNotMatch(html, />Experiment</, "experiment columns stay hidden by default");
});

test("active filters are chips with their own remove buttons", () => {
  const html = renderRuns("?errorOnly=1&facetModel=claude-sonnet");
  assert.match(html, /Status is<\/span><span[^>]*>Failed/);
  assert.match(html, /Model is<\/span><span[^>]*>claude-sonnet/);
  assert.match(html, /aria-label="Remove Status is filter"/);
  assert.match(html, />Clear filters</);
});

test("two picked runs offer Compare, linking to the existing compare page", () => {
  const html = renderRuns(`?range=7d&compare=${TRACE_A},${TRACE_B}`);
  assert.match(html, /role="region" aria-label="Compare turns"/);
  assert.match(
    html,
    new RegExp(
      `href="/project/${PROJECT}/traces/compare\\?range=7d&amp;compare=${TRACE_A}%2C${TRACE_B}&amp;a=${TRACE_A}&amp;b=${TRACE_B}"`,
    ),
  );
  const one = renderRuns(`?compare=${TRACE_A}`);
  assert.match(one, /Pick one more to compare/);
  assert.doesNotMatch(renderRuns(), /aria-label="Compare turns"/, "nothing picked, no bar");
});

test("numbers that did not load say so with a retry, never as zeros; the list still shows", () => {
  const html = renderRuns("?range=7d", { stats: null, volume: null });
  assert.match(html, /These numbers did not load/);
  assert.match(html, />Try again</);
  assert.doesNotMatch(html, /No failed turns/);
  assert.doesNotMatch(html, /data-mini-volume/);
  assert.equal(html.match(/<dt/g), null, "no key numbers at all");
  assert.match(html, /<caption class="sr-only">Turns<\/caption>/);
  const bare = renderRuns("?range=7d", { detailsUnavailable: true });
  assert.match(bare, /Tools and asks did not load for these turns\./);
});

test("a run whose top-level span has not arrived reads as incomplete, with a neutral dot", () => {
  const html = renderRuns("", { rows: [run(TRACE_A, { status: "incomplete" })] });
  assert.match(
    html,
    /<span aria-hidden="true" class="[^"]*bg-fg-faint"><\/span>Incomplete<\/span>/,
  );
  assert.doesNotMatch(html, /bg-success"><\/span>Completed/, "never a green Completed");
});

test("an empty project teaches the first step; a filtered-out list offers to clear", () => {
  const first = renderRuns("", { rows: [], empty: "no-telemetry", apiKey: noApiKeyCta(PROJECT) });
  assert.match(first, /No turns yet/);
  assert.match(
    first,
    new RegExp(`href="/project/${PROJECT}/settings/api-keys"[^>]*>Create an API key`),
  );
  assert.match(first, /href="https:\/\/docs\.ratel\.sh\/observability"/);
  assert.doesNotMatch(first, /role="toolbar"/, "nothing to filter yet");
  const filtered = renderRuns("?errorOnly=1", { rows: [], empty: "filtered" });
  assert.match(filtered, /No turns match/);
  assert.match(filtered, />Clear filters</);
  assert.match(filtered, /role="toolbar"/);
});

test("an empty project that has a key sends the first trace, and only views its keys", () => {
  const html = renderRuns("", { rows: [], empty: "no-telemetry", apiKey: WITH_KEY });
  assert.match(
    html,
    /href="https:\/\/docs\.ratel\.sh\/observability"[^>]*data-api-key-step="next"[^>]*>Send your first trace</,
  );
  assert.match(
    html,
    new RegExp(`href="/project/${PROJECT}/settings/api-keys"[^>]*>View API keys<`),
  );
  assert.doesNotMatch(html, /Create (an )?API key/, "never asked to make a second key");
});

const T0 = Date.parse("2026-09-03T10:43:35.413Z");

function otelSpan(overrides: Partial<OtelSpan> & { spanId: string; at?: number }): OtelSpan {
  const { at = 0, ...rest } = overrides;
  const startedAt = new Date(T0 + at);
  const durationMs = rest.durationMs ?? 100;
  return {
    id: `00000000-0000-8000-8000-${rest.spanId.slice(-12).padStart(12, "0")}`,
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
    events: null,
    links: null,
    ...rest,
  };
}

const SPANS: OtelSpan[] = [
  otelSpan({
    spanId: "f7a1000000000011",
    parentSpanId: null,
    name: "agent.run",
    operationName: "agent.run",
    durationMs: 2772,
    statusCode: 2,
  }),
  otelSpan({
    spanId: "f7a1000000000012",
    name: "chat",
    spanClass: "llm_call",
    model: "gpt-5",
    durationMs: 2731,
    statusCode: 2,
    inputTokens: 5144,
    outputTokens: 1707,
    costUsd: "0.029930",
    attributes: { "error.type": "upstream_timeout" },
  }),
  otelSpan({
    spanId: "f7a1000000000013",
    at: 2731,
    name: "capabilities.search",
    spanClass: "ratel_search",
    durationMs: 41,
    searchQuery: "create a database migration",
    searchHitCount: 5,
  }),
];

function traceProps(overrides: Partial<TraceViewProps> = {}): TraceViewProps {
  const summary = buildRunSummary(SPANS, 0);
  return {
    projectId: PROJECT,
    traceId: TRACE_A,
    title: summary.title,
    service: "agent-demo",
    startedAt: summary.startedAt,
    status: summary.status,
    totals: summary.totals,
    waterfall: buildTraceWaterfall(SPANS),
    truncated: false,
    lifecycle: [],
    listHref: `/project/${PROJECT}/traces?range=3m`,
    compareHref: `/project/${PROJECT}/traces?range=3m&compare=${TRACE_A}`,
    initialTab: "timeline",
    initialSpanId: null,
    runtimeEventsRoot: null,
    ...overrides,
  };
}

function renderTrace(overrides: Partial<TraceViewProps> = {}): string {
  return renderToStaticMarkup(
    inRouter(
      `/project/${PROJECT}/traces/${TRACE_A}`,
      "",
      createElement(TraceView, traceProps(overrides)),
    ),
  );
}

test("the full trace has its crumb, one h1, copy and compare, and the five numbers", () => {
  const html = renderTrace();
  assert.equal(html.match(/<h1/g)?.length, 1);
  assert.match(
    html,
    new RegExp(`<a[^>]*href="/project/${PROJECT}/traces\\?range=3m"[^>]*>Traces</a>`),
  );
  assert.match(html, /<h1[^>]*>agent\.run<\/h1>/);
  assert.match(html, /aria-label="Copy trace ID"/);
  assert.match(
    html,
    new RegExp(`href="/project/${PROJECT}/traces\\?range=3m&amp;compare=${TRACE_A}"[^>]*>Compare`),
  );
  const stats = html.slice(html.indexOf("<dl"), html.indexOf("</dl>"));
  assert.deepEqual(
    [...stats.matchAll(/<dt[^>]*>([^<]+)<\/dt>/g)].map((match) => match[1]),
    ["Status", "Duration", "Spans", "Tokens", "Cost"],
  );
  assert.match(html, /2 of 3 spans failed/);
  assert.match(html, /1 model call, 1 search/);
  assert.match(html, /role="tablist"/);
  assert.match(html, />Timeline</);
  assert.match(html, />Conversation</);
  assert.match(html, />Details</);
  assert.doesNotMatch(html, />Ranking</, "no ranking records, no Ranking tab");
  assert.doesNotMatch(html, /\u2014/);
});

test("the timeline is a tree of plain step names with the selection, the folds and the failures marked", () => {
  const html = renderTrace({ initialSpanId: "f7a1000000000012" });
  assert.match(html, /role="tree" aria-label="Steps in this trace"/);
  assert.equal(html.match(/role="treeitem"/g)?.length, 3);
  assert.match(
    html,
    /role="treeitem" aria-level="1" aria-selected="false" aria-expanded="true"/,
    "the root folds",
  );
  assert.match(
    html,
    /aria-level="2" aria-selected="true"[^>]*tabindex="0"[^>]*data-span-id="f7a1000000000012"[^>]*data-step-kind="model"[^>]*data-failed="true"/,
  );
  assert.match(html, /data-step-kind="search"/);
  assert.match(html, />Model call</);
  assert.match(html, /“create a database migration”/);
  assert.equal(
    html.match(/role="treeitem"[^>]*tabindex="0"/g)?.length,
    1,
    "one row in the tab order",
  );
  assert.match(html, /aria-label="Selected step"/);
  assert.match(html, /upstream_timeout/);
});

test("Details shows raw names; Ranking appears only with records; a long run says it was cut", () => {
  const details = renderTrace({ initialTab: "details", initialSpanId: "f7a1000000000012" });
  assert.match(details, /data-span-details/);
  assert.match(details, />error\.type</);
  assert.match(details, />f7a1000000000012</);
  const ranking = renderTrace({
    initialTab: "ranking",
    lifecycle: [
      {
        id: "log-1",
        eventName: "ratel.experiment.comparison",
        occurredAt: "2026-09-03T10:43:36.000Z",
        experimentName: "reranker",
        experimentArm: "candidate",
        experimentRole: "shadow",
        experimentAttrs: { "ratel.experiment.agreement.top1": false },
      },
    ],
  });
  assert.match(ranking, />Ranking</);
  assert.match(ranking, /data-ranking/);
  assert.match(ranking, /Variant candidate/);
  assert.match(ranking, /\(comparison\)/, "a shadow arm reads as the comparison variant");
  assert.match(ranking, /Same first pick/);
  assert.doesNotMatch(ranking, /\bshadow\b/i);
  const cut = renderTrace({ truncated: true });
  assert.match(cut, /role="note"[^>]*>(?:(?!<\/div>).)*longer than 5,000 spans/);
});

test("a run still going reads as incomplete on its own page too", () => {
  const html = renderTrace({
    status: "incomplete",
    totals: { ...buildRunSummary(SPANS, 0).totals, failedSpans: 0 },
  });
  const stats = html.slice(html.indexOf("<dl"), html.indexOf("</dl>"));
  assert.match(stats, /bg-fg-subtle"><\/span>Incomplete</);
  assert.match(stats, /Still running, or its end was never sent/);
  assert.doesNotMatch(stats, /Completed|Every span succeeded/);
});

test("Conversation says plainly when content isn't captured", () => {
  const html = renderTrace({ initialTab: "conversation" });
  assert.match(html, /data-conversation/);
  assert.match(html, /Message content isn(?:&#x27;|')t captured/);
  assert.match(html, /This turn called no tools\./);
});

test("Conversation shows the run's payload content when its spans carry none (RC-393)", () => {
  const html = renderTrace({
    initialTab: "conversation",
    payloadContent: {
      messages: [
        { id: "p:0", role: "user", text: "Where is order 1234?" },
        { id: "p:1", role: "assistant", text: "It shipped yesterday." },
      ],
      toolCalls: [
        {
          id: "c1",
          name: "lookup_order",
          arguments: { orderId: "1234" },
          result: { status: "shipped" },
          spanId: "",
          durationMs: 400,
          statusCode: 0,
        },
      ],
      contentCaptured: true,
    },
  });
  assert.doesNotMatch(html, /Message content isn(?:&#x27;|')t captured/);
  assert.match(html, /Where is order 1234\?/);
  assert.match(html, /It shipped yesterday\./);
  assert.match(html, /lookup_order/);
});

test("a later turn's Conversation folds what earlier turns sent again (RC-500)", () => {
  const payloadContent = {
    messages: [
      { id: "p:0", role: "user" as const, text: "Where is order 1234?", earlier: true },
      { id: "p:1", role: "assistant" as const, text: "It shipped yesterday.", earlier: true },
      { id: "p:2", role: "user" as const, text: "And order 99?" },
    ],
    toolCalls: [],
    contentCaptured: true,
  };
  const html = renderTrace({ initialTab: "conversation", payloadContent });
  assert.match(html, /Earlier in the session/);
  assert.match(html, /2 messages sent again as history/);
  assert.equal(html.match(/data-earlier="true"/g)?.length, 2);
  assert.match(html, /And order 99\?/);
});

test("the run Panel reads like a conversation: the ask, the steps in order, the failures, the answer", () => {
  const summary = buildRunSummary([
    ...SPANS.slice(0, 2).map((span) =>
      span.spanClass === "llm_call"
        ? {
            ...span,
            attributes: {
              ...span.attributes,
              "gen_ai.input.messages": JSON.stringify([
                { role: "user", parts: [{ type: "text", content: "Make a migration" }] },
              ]),
            },
          }
        : span,
    ),
    SPANS[2],
  ]);
  const html = renderToStaticMarkup(
    createElement(RunSummaryBody, { summary, truncated: false, fullTraceHref: "/t" }),
  );
  assert.match(html, /data-run-summary/);
  assert.match(html, />Asked<\/h3><p[^>]*>Make a migration</);
  assert.ok(html.indexOf(">Model call<") < html.indexOf(">Search<"), "steps keep their order");
  assert.match(html, /data-step-kind="model" data-failed="true"/);
  assert.match(html, /upstream_timeout/);
  assert.doesNotMatch(html, /isn(?:&#x27;|')t captured/, "content was captured");
  const silent = renderToStaticMarkup(
    createElement(RunSummaryBody, {
      summary: buildRunSummary(SPANS),
      truncated: true,
      fullTraceHref: "/t",
    }),
  );
  assert.match(silent, /Message content isn(?:&#x27;|')t captured/);
  assert.match(silent, /first 5,000 spans/);
});
