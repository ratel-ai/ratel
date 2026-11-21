// The runner only picks up `.ts`, so components are built with createElement.
// Owned (ADR-0030): the Adaptive ranking cases land with match quality; the Intents cases are upstream's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { hierarchy, pack } from "d3-hierarchy";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AsksPack, nameOf, opens } from "@/components/console/intent-map/AsksPack";
import { Group } from "@/components/console/intent-map/MapMarks";
import { FlowsView } from "@/components/console/intents/FlowsView";
import { AlsoWants, AskFor } from "@/components/console/intents/IntentBreakdown";
import { IntentSteps } from "@/components/console/intents/IntentSteps";
import { MapView } from "@/components/console/intents/MapView";
import { TopicBody } from "@/components/console/intents/TopicPanel";
import {
  IntentLead,
  intentTableRows,
  RowToggle,
  TABLE_CHILDREN,
} from "@/components/console/intents/TopicsTable";
import { TopicsView } from "@/components/console/intents/TopicsView";
import { buildFlows, type FlowTurn } from "@/lib/readings/topics/flows";
import type { StoredTopic, TopicInsights, TopicStats } from "@/lib/readings/topics/types";
import type { IntentBreakdown, IntentBreakdownSummary } from "@/lib/views/intents/breakdown";
import { layoutAsks } from "@/lib/views/intents/map/asks-pack";
import { topicMapModel } from "@/lib/views/intents/topics-map-model";
import { buildIntentSteps } from "@/lib/views/intents/topics-steps";
import {
  asksRedirectHref,
  buildTopicsView,
  type IntentsReading,
} from "@/lib/views/intents/topics-view";

const PROJECT = "p1";

/** The app router's contexts, at a URL with `search`, so client links, tabs and panels render as they do in the app. */
function inApp(pathname: string, children: ReactNode, search = ""): ReactElement {
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
      createElement(
        SearchParamsContext.Provider,
        { value: new URLSearchParams(search) as never },
        children,
      ),
    ),
  );
}

// Topic names come from people's asks (or, with no model, are one of them): text, never an attribute.
const NAMES = {
  t_order: "Where is order 1042 for jane@acme.io",
  t_rent: "Rent a scissor lift",
  t_spec: "Spec questions",
} as const;

function stored(topicId: keyof typeof NAMES): StoredTopic {
  return {
    topicId,
    name: NAMES[topicId],
    description: `${NAMES[topicId]}, asked often.`,
    labelSource: "words",
    model: null,
    inputHash: "h",
    retiredAt: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
  };
}

function stats(over: Partial<TopicStats> & { id: string }): TopicStats {
  return {
    turns: 10,
    asks: 4,
    daily: Array.from({ length: 30 }, (_, i) => i % 3),
    answered: 10,
    sentiment: null,
    tasks: [],
    untasked: 0,
    tools: [],
    selfCorrections: null,
    examples: ["turn-1"],
    askedAgain: 0,
    next: [],
    ...over,
  };
}

let clock = Date.parse("2026-10-20T09:00:00Z");
function turn(session: string, key: string, answered = true): FlowTurn {
  clock += 60_000;
  return {
    id: `f-${clock}`,
    sessionId: session,
    endUserKey: null,
    startedAt: new Date(clock),
    endedAt: new Date(clock + 20_000),
    key,
    answered,
    calls: [{ tool: "lookup_order", outcome: answered ? "ok" : "error" }],
  };
}

const FLOWS = buildFlows([
  [turn("a", "t_order"), turn("a", "retry"), turn("a", "t_spec")],
  [turn("b", "t_order"), turn("b", "t_rent", false)],
  [turn("c", "t_rent", false)],
  [turn("d", "t_rent", false)],
  [turn("e", "t_rent", false)],
  [turn("f", "t_rent", false)],
  [turn("g", "t_rent", false)],
  [turn("h", "t_spec")],
]);

function insights(over: Partial<TopicInsights> = {}): TopicInsights {
  return {
    version: 1,
    windowDays: 30,
    windowStart: "2026-09-20T00:00:00.000Z",
    windowEnd: "2026-10-20T00:00:00.000Z",
    readFrom: "2026-09-20T00:00:00.000Z",
    capped: false,
    turns: 120,
    sources: { user: 100, prompt: 0, search: 20, none: 0 },
    verdicts: { topic: 100, retry: 4, none: 16, no_ask: 0 },
    sentimentMeasured: 60,
    naming: "model",
    placement: "judged",
    namingHash: null,
    topics: [
      stats({
        id: "t_order",
        turns: 60,
        answered: 50,
        sentiment: { positive: 2, neutral: 40, negative: 18 },
        tasks: [{ id: "wf_track", turns: 40 }],
        untasked: 20,
        tools: [{ id: "lookup_order", calls: 70, failures: 9 }],
        selfCorrections: { events: 6, turns: 5, byKind: { retry_after_error: 4, asked_again: 2 } },
        next: [
          { key: "ended", sessions: 30 },
          { key: "t_spec", sessions: 5 },
          { key: "retry", sessions: 4 },
        ],
        askedAgain: 4,
      }),
      stats({
        id: "t_rent",
        turns: 30,
        answered: 2,
        tools: [{ id: "get_project_info", calls: 20, failures: 0 }],
      }),
      stats({ id: "t_spec", turns: 10, answered: 10 }),
    ],
    unplaced: { turns: 16, answered: 10 },
    tools: [
      { id: "lookup_order", calls: 70, failures: 9, task: "wf_track" },
      { id: "get_project_info", calls: 20, failures: 0, task: null },
    ],
    flows: FLOWS,
    flowsBlocked: null,
    ...over,
  };
}

function reading(over: Partial<TopicInsights> = {}): IntentsReading {
  const data = insights(over);
  return {
    status: "ready",
    view: buildTopicsView({
      projectId: PROJECT,
      insights: data,
      topics: [stored("t_order"), stored("t_rent"), stored("t_spec")],
      tasks: [{ id: "wf_track", runs: 200, typicalOrder: ["lookup_order"] }],
      taskLabels: new Map([["wf_track", { name: "Track an order" }]]),
    }),
    flows: data.flows,
    flowsBlocked: data.flowsBlocked,
    lanes: data.lanes ?? null,
    tools: data.tools,
    turns: data.turns,
    modelOnlyTurns: 0,
    read: { relative: "12 min ago", absolute: "20 Oct 2026, 08:48 UTC" },
    inFlight: false,
  };
}

const loadExamples = async () => ({ ok: true as const, examples: [] });
const loadLeads = async () => ({ ok: true as const, leads: {} });
const loadRows = async () => ({ ok: true as const, rows: {} });
const loadDetail = async () => ({
  ok: true as const,
  breakdown: null,
  steps: { status: "none" as const },
});
const loadAsks = async () => ({ ok: true as const, trees: {} });
const requestReading = async () => ({ ok: true as const, coalesced: false });

/** Every attribute value in the markup. */
function attributeValues(html: string): string[] {
  return [...html.matchAll(/\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"/g)].map(
    ([, , value]) => value,
  );
}

/** Topic names are people's words: they may be text, never an attribute (ids carry them everywhere). */
function assertNoNameInAttributes(html: string) {
  for (const value of attributeValues(html)) {
    for (const name of Object.values(NAMES)) {
      assert.ok(
        !value.toLowerCase().includes(name.toLowerCase()),
        `an attribute carries "${name}": ${value}`,
      );
    }
  }
}

function assertCalm(html: string) {
  assert.doesNotMatch(html, /\u2014/, "no em dashes");
  assert.doesNotMatch(
    html,
    /uppercase|cluster|ask group|workflow|Tool craft|suggestion|signal|Jev|BM25/i,
    "no eyebrows, old nouns or engine names",
  );
}

/** What a reader sees: the markup's text, tags gone, entities read, spaces collapsed. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** UI copy never says "topic": an intent is what people want (DESIGN.md, The product's nouns). Ids and URLs may. */
function assertIntentsWords(html: string) {
  assert.doesNotMatch(text(html), /\btopics?\b/i, "the copy says intent, never topic");
}

const renderTopics = (data: IntentsReading, search = "", leads: typeof loadLeads = loadLeads) =>
  renderToStaticMarkup(
    inApp(
      `/project/${PROJECT}/intents`,
      createElement(TopicsView, {
        projectId: PROJECT,
        reading: data,
        loadExamples,
        loadLeads: leads,
        loadRows,
        loadDetail,
        requestReading,
      }),
      search,
    ),
  );

const renderFlows = (data: IntentsReading, search = "") =>
  renderToStaticMarkup(
    inApp(
      `/project/${PROJECT}/intents/flows`,
      createElement(FlowsView, { projectId: PROJECT, reading: data, loadExamples, requestReading }),
      search,
    ),
  );

/** The reading with t_order's asks spread over 45 conversations. */
function withConversations(over: Partial<TopicInsights> = {}) {
  return reading({
    topics: insights().topics.map((topic) =>
      topic.id === "t_order" ? { ...topic, conversations: 45 } : topic,
    ),
    ...over,
  });
}

test("All intents answers its question: a legend of the nouns with their numbers, then every intent as a row", () => {
  const html = renderTopics(withConversations());
  assert.equal(html.match(/<h1/g)?.length, 1);
  assert.match(html, /<a[^>]*href="\/project\/p1\/intents"[^>]*>Intents<\/a>/, "the crumb");
  assert.match(html, /<h1[^>]*>All intents<\/h1>/);
  assert.match(html, /data-intents-legend=""/);
  assert.match(
    text(html),
    /120 asks grouped into 3 intents handled by 1 task/,
    "the legend, a sentence for a screen reader",
  );
  assert.match(
    html,
    /<a[^>]*href="\/project\/p1\/health\/tasks"[^>]*>(?:(?!<\/a>)[\s\S])*task<\/a>/,
    "tasks lead to Tasks",
  );
  assert.doesNotMatch(html, /<dl/, "no stat tiles: the numbers live in the legend and the rows");
  assert.match(html, />Last 30 days, read 12[ {2}]min ago</);
  assert.match(html, /<caption class="sr-only">Intents<\/caption>/);
  for (const header of ["Intent", "Asks", "Answered", "Sentiment", "Tasks"])
    assert.match(html, new RegExp(`>${header}<`));
  assert.match(html, /aria-sort="descending"/, "busiest first, and the header says so");
  assert.match(
    html,
    /role="img" aria-label="Asks every two days over the last 30 days"/,
    "a quiet trend",
  );
  assert.match(
    text(html),
    /60 asks in 45 conversations/,
    "an intent's asks and the conversations they were asked in",
  );
  assert.match(html, /role="meter" aria-label="Answered 83%"/, "answered as a meter");
  assert.match(html, /aria-label="Sentiment: 2 positive, 40 neutral, 18 negative"/);
  assert.match(
    html,
    />30%<span class="sr-only"> negative<\/span></,
    "the negative share, said in words for a screen reader",
  );
  assert.match(
    html,
    /<button[^>]*aria-label="How sentiment is read"/,
    "sentiment says how it is read, one hover away",
  );
  assert.match(html, /<button[^>]*aria-label="What answered means"/);
  assert.match(
    html,
    /<a[^>]*href="\/project\/p1\/health\/tasks\/wf_track"[^>]*>(?:(?!<\/a>)[\s\S])*bg-chart-1(?:(?!<\/a>)[\s\S])*Track an order/,
    "its task as a pin in its color, linked by id",
  );
  assert.match(html, />Mostly unanswered</, "the intent that went unanswered says so");
  assert.match(text(html), /16 of 120 asks fit no intent · 4 asked again/);
  assertNoNameInAttributes(html);
  assertCalm(html);
  assertIntentsWords(html);
});

test("an intent's example ask is read once the list is on screen: never by the server render, never in an attribute", () => {
  let reads = 0;
  const leads = async () => {
    reads += 1;
    return {
      ok: true as const,
      leads: {
        t_order: { id: "turn-1", text: "Did my rebar ship", source: "user" as const, href: "/x" },
      },
    };
  };
  const html = renderTopics(reading(), "", leads);
  assert.equal(reads, 0, "nothing is read while the server renders the page");
  assert.ok(
    !html.includes("Did my rebar ship"),
    "captured text stays out of the server-rendered page",
  );
  const quote = renderToStaticMarkup(
    createElement(IntentLead, {
      leads: {
        status: "ready",
        leads: {
          t_order: {
            id: "turn-1",
            text: "Where is order 1042 for jane@acme.io",
            source: "user",
            href: "/x",
          },
        },
      },
      topic: (reading() as Extract<IntentsReading, { status: "ready" }>).view.topics[0]!,
    }),
  );
  assert.match(
    quote,
    /<span class="sr-only">Their words: <\/span>/,
    "marked as the person's own words",
  );
  assert.match(quote, />“Where is order 1042 for jane@acme\.io”</, "in quotes, as text");
  assertNoNameInAttributes(quote);
  const searched = renderToStaticMarkup(
    createElement(IntentLead, {
      leads: {
        status: "ready",
        leads: {
          t_order: { id: "turn-1", text: "order 1042 status", source: "search", href: "/x" },
        },
      },
      topic: (reading() as Extract<IntentsReading, { status: "ready" }>).view.topics[0]!,
    }),
  );
  assert.match(
    searched,
    /The agent&#x27;s search: /,
    "an agent's search standing in for the ask says so",
  );
  const none = renderToStaticMarkup(
    createElement(IntentLead, {
      leads: { status: "error" },
      topic: (reading() as Extract<IntentsReading, { status: "ready" }>).view.topics[0]!,
    }),
  );
  assert.match(
    none,
    /Where is order 1042 for jane@acme\.io, asked often\./,
    "no example to read: its description",
  );
});

test("asks with no words to read are counted, and the page says what to send for them", () => {
  const base = insights();
  const html = renderTopics(reading({ verdicts: { ...base.verdicts, no_ask: 40 } }));
  assert.match(
    text(html),
    /16 of 120 asks fit no intent · 40 carried no words to read · 4 asked again/,
  );
  assert.match(html, /<button[^>]*aria-label="What needs people&#x27;s own words"/);
});

test("without people's own words there is no sentiment column, and the page says what would read it", () => {
  const html = renderTopics(
    reading({
      sentimentMeasured: 0,
      topics: insights().topics.map((topic) => ({ ...topic, sentiment: null })),
    }),
  );
  assert.doesNotMatch(html, />Sentiment</);
  assert.doesNotMatch(html, /aria-label="How sentiment is read"/);
  assert.match(html, /aria-label="What needs people&#x27;s own words"/);
  assert.doesNotMatch(
    text(html),
    /in \d+ conversations/,
    "a reading before conversations were counted shows asks alone",
  );
});

test("before the first reading, All intents says what fills it and offers to read now; while one runs it waits in place", () => {
  const empty = renderTopics({ status: "none", inFlight: false });
  assert.match(empty, /aria-label="No intents yet"/);
  assert.match(empty, />No intents yet</);
  assert.match(
    text(empty),
    /Asks grouped into Intents handled by Tasks/,
    "the legend still teaches the nouns, without numbers",
  );
  assert.match(empty, /<button[^>]*>Read now<\/button>/);
  assert.doesNotMatch(empty, /<table/, "no rows before there are any");
  const running = renderTopics({ status: "none", inFlight: true });
  assert.match(running, />Reading what people ask</);
  assert.match(running, /Intents fill in here when it finishes/);
  assert.match(running, /data-health-watching=""/, "the page reads itself again");
  assert.doesNotMatch(running, />Read now</);
  const ready = reading() as Extract<IntentsReading, { status: "ready" }>;
  const nothing = renderTopics({ ...ready, view: { ...ready.view, topics: [] } });
  assert.match(nothing, />No asks to group yet</);
  assert.match(nothing, />Read again</);
  const failed = renderTopics({ status: "failed" });
  assert.match(failed, /role="note"[\s\S]*Couldn&#x27;t load intents/);
  for (const html of [empty, running, nothing, failed]) {
    assertCalm(html);
    assertIntentsWords(html);
  }
});

test("an intent's panel: numbers as marks, examples read on open, tasks and tools as pins, what came next, and its neighbours", () => {
  const view = (withConversations() as Extract<IntentsReading, { status: "ready" }>).view;
  const html = renderToStaticMarkup(
    inApp(
      `/project/${PROJECT}/intents`,
      createElement(TopicBody, { topic: view.topics[0]!, loadExamples, onOpen: () => {} }),
      "peek=t_order",
    ),
  );
  assert.match(html, /data-panel-kind="intent"/);
  assert.match(
    text(html),
    /Asks 60 in 45 conversations Answered 83% 50 of 60 Negative 30% Read on 60 of 60 asks\. Asked again 4 right after/,
    "the numbers, each with its mark",
  );
  assert.match(html, /role="meter" aria-label="Answered 83%"/);
  assert.match(html, />Example asks</);
  assert.match(html, /aria-busy="true"/, "read when the panel opens, not with the page");
  assert.match(
    html,
    /<a[^>]*href="\/project\/p1\/health\/tasks\/wf_track"[^>]*>(?:(?!<\/a>)[\s\S])*Track an order/,
    "a task is its pin",
  );
  assert.match(text(html), /Track an order 67% No task 33%/);
  assert.match(
    html,
    /<a[^>]*href="\/project\/p1\/catalogs\/tools\?q=lookup_order&amp;highlight=lookup_order"[^>]*>(?:(?!<\/a>)[\s\S])*lookup_order/,
    "a tool is its pin, linking to Catalog",
  );
  assert.match(text(html), /lookup_order 70 calls 9 failed/);
  assert.match(html, />What people want next</);
  assert.match(
    html,
    /<button type="button"[^>]*>(?:(?!<\/button>)[\s\S])*Spec questions(?:(?!<\/button>)[\s\S])*<\/button>/,
    "an intent that came next opens its own panel",
  );
  assert.match(text(html), /Ended 77%/);
  assert.match(text(html), /Asked again 10%/);
  assert.match(
    text(html),
    /6 in 5 asks Retried 4 Asked again 2/,
    "self-corrections, each kind as a badge",
  );
  assert.match(html, /href="\/project\/p1\/health\/self-corrections\?topic=t_order"/);
  assert.match(html, /href="\/project\/p1\/improvement\/fixes\?topic=t_order"/);
  assert.match(html, /href="\/project\/p1\/intents\/flows\?start=t_order"/);
  assertNoNameInAttributes(html);
  assertCalm(html);
  assertIntentsWords(html);
});

test("Flows: a Start from control, a legend of kinds, columns named by ask, and every chip marked by its kind", () => {
  const html = renderFlows(reading());
  assert.match(html, /<h1[^>]*>Flows<\/h1>/);
  assert.match(html, /What people want next, ask after ask\./);
  assert.match(html, />Start from</);
  assert.match(html, /aria-label="Start from"/);
  assert.match(html, />Everyone</, "everyone, until a first ask is followed");
  assert.doesNotMatch(html, />Clear</);
  assert.match(html, /<ul aria-label="What each mark is"[\s\S]*>Intent<[\s\S]*>Asked again</);
  assert.doesNotMatch(
    html,
    /<ul aria-label="What each mark is"(?:(?!<\/ul>)[\s\S])*>Tool</,
    "only the kinds drawn",
  );
  assert.match(html, /aria-label="How steps are named"/);
  assert.match(html, /data-flow-canvas=""/);
  assert.match(html, />1st ask<[\s\S]*>2nd ask<[\s\S]*>3rd ask<[\s\S]*>Then</);
  assert.doesNotMatch(
    text(html),
    /Step \d/,
    "columns are asks, not steps: a task's Steps are its tools",
  );
  assert.match(
    html,
    /1st ask: <\/span>[\s\S]*?Intent: <\/span>[\s\S]*?Rent a scissor lift/,
    "a chip says its kind",
  );
  assert.match(
    html,
    /border-dashed[^"]*"[^>]*>(?:(?!<\/button>)[\s\S])*Asked again/,
    "Asked again is drawn apart",
  );
  assert.match(html, />unanswered</, "a step whose asks mostly went unanswered says so");
  assert.match(html, />Ended</);
  assert.match(html, /<path d="M[\d.]+ [\d.]+ C/, "ribbons");
  assert.match(html, /fill-fg\/\[0\.12\]/, "ribbons rest in gray");
  assertNoNameInAttributes(html);
  assertCalm(html);
  assertIntentsWords(html);
});

test("following a first ask: the control says so, the drawing keeps only those conversations, and Clear goes back", () => {
  const html = renderFlows(reading(), "start=t_order");
  assert.match(html, />Following</);
  assert.match(html, /<button[^>]*>(?:(?!<\/button>)[\s\S])*Clear<\/button>/);
  assert.match(html, />1st ask<span[^>]*>2<\/span>/, "the two conversations that started there");
  assertNoNameInAttributes(html);
});

test("Flows draws tasks and tools when no ask carried words to read", () => {
  const silent = buildFlows([
    [turn("s1", "task:wf_track"), turn("s1", "tool:lookup_order")],
    [turn("s2", "task:wf_track")],
  ]);
  const html = renderFlows(reading({ topics: [], flows: silent }));
  assert.match(html, /data-flow-canvas=""/);
  assert.match(html, /Task: <\/span>[\s\S]*?Track an order/);
  assert.match(html, /Tool: <\/span>[\s\S]*?lookup_order/);
  assert.match(html, /<ul aria-label="What each mark is"[\s\S]*>Task<[\s\S]*>Tool</);
});

test("Flows says plainly when it can't follow conversations, and what to send, from either lane", () => {
  const mixed = renderFlows(
    reading({
      flows: null,
      flowsBlocked: "sessions_mixed",
      lanes: { telemetry: 0, sdk: 120, telemetryWithoutConversation: 0 },
    }),
  );
  assert.match(mixed, /data-flows-gap=""/);
  assert.match(mixed, />Can&#x27;t follow conversations yet</);
  assert.match(text(mixed), /end-user id/);
  assert.doesNotMatch(mixed, /data-flow-canvas/);
  const alone = renderFlows(
    reading({
      flows: buildFlows([[turn("x", "t_order")], [turn("y", "t_spec")]]),
      lanes: { telemetry: 120, sdk: 0, telemetryWithoutConversation: 120 },
    }),
  );
  assert.match(alone, />Every ask stands alone</);
  assert.match(alone, /gen_ai\.conversation\.id/);
  assert.doesNotMatch(alone, /data-flow-canvas/);
  const partial = renderFlows(
    reading({ lanes: { telemetry: 100, sdk: 20, telemetryWithoutConversation: 12 } }),
  );
  assert.match(partial, /data-flow-canvas=""/);
  assert.match(
    partial,
    />12 runs carried no conversation id, so each counts as a conversation of one ask\.</,
  );
  for (const html of [mixed, alone, partial]) {
    assertCalm(html);
    assertIntentsWords(html);
  }
});

test("Map draws intents as blobs in their main task's tint, named by id; a problem is the warning mark, never an amber outline", () => {
  const data = reading() as Extract<IntentsReading, { status: "ready" }>;
  const model = topicMapModel(data.view, data.tools);
  const html = renderToStaticMarkup(
    inApp(
      `/project/${PROJECT}/intents/map`,
      createElement(MapView, {
        projectId: PROJECT,
        reading: data,
        map: { model, steps: [] },
        loadExamples,
        loadDetail,
        loadAsks,
        requestReading,
      }),
    ),
  );
  assert.match(html, /<h1[^>]*>Map<\/h1>/);
  assert.match(html, /data-intent-map-view="map"/);
  assert.match(html, /aria-label="Find an intent or tool"/);
  assert.match(
    html,
    />Map<\/button>[\s\S]*>Asks<\/button>[\s\S]*>Flow<\/button>[\s\S]*>Tools<\/button>/,
    "the Asks lens sits beside the map",
  );
  assert.doesNotMatch(html, /aria-label="Graph"/, "graphs belong to Adaptive ranking");
  assert.match(
    html,
    /Each blob is an intent, holding the tools its asks used\./,
    "the page says what a blob is",
  );
  assert.doesNotMatch(html, /\btopics?\b/i, "the product's word is intent");
  assertNoNameInAttributes(html);
  assertCalm(html);

  const rent = model.asks.find((ask) => ask.id === "t_rent")!;
  assert.deepEqual(rent.problem, { kind: "unanswered", rate: 28 / 30 });
  const order = model.asks.find((ask) => ask.id === "t_order")!;
  assert.equal(order.tint, "chart-1");
  const blob = renderToStaticMarkup(
    createElement(
      "svg",
      null,
      createElement(Group, {
        ask: order,
        path: "M0,0L10,0L10,10Z",
        state: "rest",
        tabIndex: 0,
        tools: 1,
        onHover: () => {},
        onOpen: () => {},
        onFocus: () => {},
        onBlur: () => {},
      }),
    ),
  );
  assert.match(blob, /aria-label="Intent t_order: 60 asks, 1 tool"/);
  assert.match(blob, /fill-chart-1\/\[0\.08\]/, "its main task's tint");
  assertNoNameInAttributes(blob);
});

test("the old Asks tab lands on Topics, keeping the open panel", () => {
  assert.equal(asksRedirectHref("p1", "t_order"), "/project/p1/intents?peek=t_order");
  assert.equal(asksRedirectHref("p1", undefined), "/project/p1/intents");
});

// What people asked, as the engine read it: text in the panel, never an attribute.
const ASKS = {
  way: "where is my order 1042",
  sample: "when will 1042 arrive",
  second: "track order for jane@acme.io",
  cancel: "cancel order 1042",
} as const;

function way(id: string, label: string, asks: number, of: number, samples: string[] = []) {
  return { id, label, asks, of, samples };
}

function breakdown(over: Partial<IntentBreakdown> = {}): IntentBreakdown {
  return {
    topicId: "t_order",
    asks: 60,
    placed: 50,
    capped: false,
    whatTheyAskFor: {
      skipped: false,
      more: 1,
      groups: [
        {
          id: "g_status",
          label: "Check an order's status",
          named: true,
          quoted: false,
          asks: 30,
          share: 0.6,
          totalAsks: 34,
          alsoIn: [{ topicId: "t_rent", asks: 4 }],
          waysOfAsking: {
            skipped: false,
            more: 2,
            ways: [
              way("c1", ASKS.way, 18, 30, [ASKS.sample]),
              way("c2", ASKS.second, 5, 30),
              way("c3", "order 1042 status", 3, 30),
              way("c4", "is 1042 shipped", 2, 30),
              way("c5", "1042?", 2, 30),
            ],
          },
        },
        {
          id: "g_cancel",
          label: ASKS.cancel,
          named: false,
          quoted: true,
          asks: 15,
          share: 0.3,
          totalAsks: 15,
          alsoIn: [],
          waysOfAsking: { skipped: true, more: 0, ways: [way("c9", ASKS.cancel, 15, 15)] },
        },
      ],
    },
    elsewhere: {
      asks: 5,
      groups: [{ id: "g_spec", label: "Read a spec sheet", topicId: "t_spec", asks: 5 }],
    },
    alsoWants: [{ topicId: "t_spec", asks: 6, share: 0.12 }],
    ...over,
  };
}

const NAME_MAP = new Map(Object.entries(NAMES));

function assertNoAskInAttributes(html: string) {
  for (const value of attributeValues(html)) {
    for (const ask of [...Object.values(ASKS), ...Object.values(NAMES)]) {
      assert.ok(
        !value.toLowerCase().includes(ask.toLowerCase()),
        `an attribute carries "${ask}": ${value}`,
      );
    }
  }
}

const renderIn = (element: ReactElement) =>
  renderToStaticMarkup(inApp(`/project/${PROJECT}/intents`, element, "peek=t_order"));

test("What they ask for: each thing with its asks and share, the first open onto the ways people ask it, quoted with true counts", () => {
  const html = renderIn(
    createElement(AskFor, { breakdown: breakdown(), names: NAME_MAP, onOpen: () => {} }),
  );
  assert.match(text(html), /What they ask for 3/, "two listed and one more");
  assert.match(
    html,
    /<button type="button" aria-expanded="true"[^>]*>(?:(?!<\/button>)[\s\S])*Check an order&#x27;s status/,
    "the busiest is open",
  );
  assert.match(text(html), /Check an order's status 30 asks 60%/);
  assert.match(
    text(html),
    /“where is my order 1042” 18 of 30/,
    "a way of asking: its most typical ask, quoted, with its count",
  );
  assert.match(text(html), /“when will 1042 arrive”/, "and a few more like it");
  assert.match(text(html), /Show 1 more/, "four at first");
  assert.doesNotMatch(text(html), /1042\?/, "the fifth waits");
  assert.match(
    text(html),
    /“cancel order 1042” 15 asks 30%/,
    "one no model has named reads as its busiest ask, quoted",
  );
  assert.doesNotMatch(
    html,
    /<button[^>]*>(?:(?!<\/button>)[\s\S])*cancel order 1042/,
    "asked one way only, it has nothing to open: the level is skipped",
  );
  assert.equal(
    text(html).split("cancel order 1042").length - 1,
    1,
    "and its one way is not said twice",
  );
  assert.match(
    text(html),
    /Also asked under Rent a scissor lift 4/,
    "a group that spans intents names them, as pins that open them",
  );
  assert.match(text(html), /and 1 more, asked less often/);
  assert.match(text(html), /Grouped from 50 of 60 asks · 5 asks read more like Spec questions/);
  assert.equal(
    (html.match(/role="meter"/g) ?? []).length,
    6,
    "a meter per thing and per way, hidden from a screen reader beside its percent",
  );
  assertNoAskInAttributes(html);
  assertCalm(html);
  assertIntentsWords(html);
});

test("a named thing asked one way shows that way under its name, with nothing to open", () => {
  const [, cancel] = breakdown().whatTheyAskFor.groups;
  const named = { ...cancel!, label: "Cancel an order", named: true, quoted: false };
  const [status] = breakdown().whatTheyAskFor.groups;
  const html = renderIn(
    createElement(AskFor, {
      breakdown: breakdown({
        whatTheyAskFor: { skipped: false, more: 0, groups: [named, status!] },
      }),
      names: NAME_MAP,
      onOpen: () => {},
    }),
  );
  assert.match(text(html), /Cancel an order “cancel order 1042” 15 asks 30%/);
  assert.match(
    html,
    /<button type="button" aria-expanded="true"[^>]*>(?:(?!<\/button>)[\s\S])*Check an order&#x27;s status/,
    "the busiest that opens starts open",
  );
  assertNoAskInAttributes(html);
});

test("an intent that is one thing goes straight to the ways people ask it; one way alone says nothing", () => {
  const [status] = breakdown().whatTheyAskFor.groups;
  const one = breakdown({ whatTheyAskFor: { skipped: true, more: 0, groups: [status!] } });
  const html = renderIn(
    createElement(AskFor, { breakdown: one, names: NAME_MAP, onOpen: () => {} }),
  );
  assert.match(text(html), /Ways people ask it 7/, "five listed and two more");
  assert.doesNotMatch(
    text(html),
    /What they ask for|Check an order's status/,
    "the skipped level is not drawn",
  );
  assert.match(text(html), /“where is my order 1042” 18 of 30/);

  const [, cancel] = breakdown().whatTheyAskFor.groups;
  const alone = breakdown({
    whatTheyAskFor: { skipped: true, more: 0, groups: [cancel!] },
    elsewhere: { asks: 0, groups: [] },
  });
  assert.equal(
    renderIn(createElement(AskFor, { breakdown: alone, names: NAME_MAP, onOpen: () => {} })),
    "",
  );
});

test("asks read from the newest of a busy window say so", () => {
  const html = renderIn(
    createElement(AskFor, {
      breakdown: breakdown({
        capped: true,
        asks: 2000,
        placed: 1800,
        elsewhere: { asks: 0, groups: [] },
      }),
      names: NAME_MAP,
      onOpen: () => {},
    }),
  );
  assert.match(text(html), /Read from the newest 2,000 asks, 1,800 grouped/);
});

test("Also wanted in the same ask: the other intents, as pins that open them, with their share of its asks", () => {
  const html = renderIn(
    createElement(AlsoWants, { breakdown: breakdown(), names: NAME_MAP, onOpen: () => {} }),
  );
  assert.match(
    html,
    /<button type="button"[^>]*>(?:(?!<\/button>)[\s\S])*Spec questions(?:(?!<\/button>)[\s\S])*<\/button>/,
  );
  assert.match(text(html), /Also wanted in the same ask Spec questions 12%/);
  assert.equal(
    renderIn(
      createElement(AlsoWants, {
        breakdown: breakdown({ alsoWants: [{ topicId: "gone", asks: 3, share: 0.1 }] }),
        names: NAME_MAP,
        onOpen: () => {},
      }),
    ),
    "",
    "an intent no longer read is left out",
  );
  assertNoAskInAttributes(html);
  assertCalm(html);
});

test("Step by step: its usual tools as pins in order, how many asks run them, the task that runs them, the helpers left out", () => {
  const view = (reading() as Extract<IntentsReading, { status: "ready" }>).view;
  const steps = buildIntentSteps({
    stats: {
      id: "t_order",
      turns: 60,
      tasks: [{ id: "wf_track", turns: 40 }],
      pattern: {
        withCalls: 58,
        tools: [{ id: "lookup_order", turns: 50 }],
        runs: 45,
        inOrder: 45,
        also: [{ id: "get_project_info", turns: 12 }],
        helpers: [{ id: "search_tools", turns: 55 }],
        firsts: [
          { id: "lookup_order", turns: 40 },
          { id: "get_project_info", turns: 5 },
        ],
        comesBefore: [{ first: "lookup_order", tool: "get_project_info", turns: 12, together: 10 }],
        skills: { invoked: 0, offered: 0 },
      },
    },
    tasks: [{ id: "wf_track", runs: 200, typicalOrder: ["lookup_order"] }],
  })!;
  const html = renderIn(
    createElement(IntentSteps, { read: { status: "ready", steps }, topic: view.topics[0]! }),
  );
  assert.match(
    html,
    /<ol aria-label="Its usual steps, in order"[^>]*>(?:(?!<\/ol>)[\s\S])*lookup_order/,
  );
  assert.match(
    html,
    /<a[^>]*href="\/project\/p1\/catalogs\/tools\?q=lookup_order&amp;highlight=lookup_order"/,
    "a tool is its pin, linking to Catalog",
  );
  assert.match(text(html), /75% of its asks run it/);
  assert.match(
    text(html),
    /Track an order runs these steps · 67% of its asks/,
    "the task whose steps these are, in its color",
  );
  assert.match(text(html), /In most asks, left out search_tools/);
  assert.match(text(html), /Every way it goes 2 steps/, "the rest behind one Details row");
  assert.match(html, /data-step-depth="2"/, "a tool under the one it comes after");
  assert.match(
    text(html),
    /lookup_order 67% Then get_project_info 17% Each share is of its 60 asks\./,
    "each with the share of the intent's asks that go that way",
  );
  assert.doesNotMatch(text(html), /Sometimes also/, "a tool already drawn is not named again");
  assert.equal(
    renderIn(createElement(IntentSteps, { read: { status: "none" }, topic: view.topics[0]! })),
    "",
  );
  assert.match(
    text(
      renderIn(createElement(IntentSteps, { read: { status: "failed" }, topic: view.topics[0]! })),
    ),
    /Couldn't read its steps/,
  );
  assertCalm(html);
  assertIntentsWords(html);
});

test("the panel reads what its asks are for and its steps when it opens, never with the page", () => {
  const view = (withConversations() as Extract<IntentsReading, { status: "ready" }>).view;
  let reads = 0;
  const html = renderIn(
    createElement(TopicBody, {
      topic: view.topics[0]!,
      names: NAME_MAP,
      loadExamples,
      loadDetail: async () => {
        reads += 1;
        return { ok: true as const, breakdown: breakdown(), steps: { status: "none" as const } };
      },
      onOpen: () => {},
    }),
  );
  assert.equal(reads, 0, "nothing is read while the server renders the panel");
  assert.match(html, /<section aria-busy="true"[^>]*>(?:(?!<\/section>)[\s\S])*What they ask for/);
  assert.match(html, /<section aria-busy="true"[^>]*>(?:(?!<\/section>)[\s\S])*Step by step/);
  assert.ok(
    text(html).indexOf("What they ask for") < text(html).indexOf("Example asks"),
    "under its numbers, before the examples",
  );
  assertNoAskInAttributes(html);
});

test("All intents opens an intent in place onto what its asks are for, when there are two things or more", () => {
  const topics = (reading() as Extract<IntentsReading, { status: "ready" }>).view.topics;
  const summary = (
    topicId: string,
    rows: IntentBreakdownSummary["rows"],
    children = rows.length,
  ): IntentBreakdownSummary => ({
    topicId,
    asks: 60,
    placed: 50,
    groups: children,
    children,
    skipped: false,
    rows,
  });
  const summaries = {
    t_order: summary(
      "t_order",
      [
        {
          id: "g_status",
          kind: "group",
          label: "Check an order's status",
          quoted: false,
          asks: 30,
          share: 0.6,
        },
        {
          id: "g_cancel",
          kind: "group",
          label: "cancel order 1042",
          quoted: true,
          asks: 15,
          share: 0.3,
        },
      ],
      3,
    ),
    t_rent: summary("t_rent", [
      { id: "c1", kind: "way", label: "rent a lift", quoted: true, asks: 9, share: 1 },
    ]),
    t_spec: summary(
      "t_spec",
      Array.from({ length: 8 }, (_, i) => ({
        id: `g${i}`,
        kind: "group" as const,
        label: `Thing ${i}`,
        quoted: false,
        asks: 8 - i,
        share: (8 - i) / 36,
      })),
      9,
    ),
  };
  const shape = (open: string[]) =>
    intentTableRows(topics, new Set(open), summaries).map((row) =>
      row.kind === "intent"
        ? `${row.topic.id}:${row.children}`
        : row.kind === "child"
          ? `  ${row.row.id}`
          : `  +${row.count}`,
    );
  assert.deepEqual(
    shape([]),
    ["t_order:3", "t_rent:0", "t_spec:9"],
    "closed, each intent says how many rows it opens onto; one alone opens onto none",
  );
  assert.deepEqual(
    shape(["t_order", "t_rent"]),
    ["t_order:3", "  g_status", "  g_cancel", "  +1", "t_rent:0", "t_spec:9"],
    "open, the listed ones then how many more",
  );
  assert.deepEqual(
    shape(["t_spec"]).slice(3),
    ["  g0", "  g1", "  g2", "  g3", "  g4", "  +4"],
    `a long tail keeps to the busiest ${TABLE_CHILDREN}; the panel lists the rest`,
  );
  assert.deepEqual(
    intentTableRows(topics, new Set(["t_order"]), null).map((row) => row.kind),
    ["intent", "intent", "intent"],
    "nothing opens before the rows are read",
  );
  const html = renderTopics(reading());
  assert.match(
    html,
    /<th[^>]*style="width:2.25rem"[^>]*><span class="sr-only">Open what they ask for<\/span><\/th>/,
    "the chevrons' column keeps its width before the rows arrive",
  );
  assert.doesNotMatch(html, /what they ask for, /, "and stays empty until they do");
});

test("an intent's chevron is named by its intent, the same open or closed; aria-expanded says which", () => {
  const toggle = (open: boolean, skipped = false) =>
    renderToStaticMarkup(
      createElement(RowToggle, {
        name: NAMES.t_order,
        skipped,
        open,
        count: 5,
        onToggle: () => {},
      }),
    );
  assert.match(toggle(false), /aria-expanded="false"/);
  assert.match(toggle(true), /aria-expanded="true"/);
  assert.equal(text(toggle(false)), `${NAMES.t_order}: what they ask for, 5`);
  assert.equal(text(toggle(true)), text(toggle(false)), "the name does not flip");
  assert.equal(
    text(toggle(false, true)),
    `${NAMES.t_order}: ways people ask it, 5`,
    "an intent that is one thing opens onto its ways",
  );
  assertNoNameInAttributes(toggle(true));
});

test("the Asks lens says where the reader is: every intent, an intent, what they ask for, and opens the intent from there", () => {
  const data = reading() as Extract<IntentsReading, { status: "ready" }>;
  const model = topicMapModel(data.view, data.tools);
  const trees = new Map([
    [
      "t_order",
      {
        topicId: "t_order",
        asks: 50,
        read: 60,
        capped: false,
        skipped: false,
        groups: [
          {
            id: "g_status",
            label: "Check an order's status",
            quoted: false,
            asks: 30,
            ways: [
              { id: "c1", label: ASKS.way, asks: 18 },
              { id: "c2", label: ASKS.second, asks: 12 },
            ],
            restAsks: 0,
            restWays: 0,
          },
          {
            id: "g_cancel",
            label: ASKS.cancel,
            quoted: true,
            asks: 20,
            ways: [],
            restAsks: 0,
            restWays: 0,
          },
        ],
        restAsks: 0,
        restGroups: 0,
      },
    ],
  ]);
  const render = (focus: string | null, status: "loading" | "ready" | "failed" = "ready") =>
    renderToStaticMarkup(
      inApp(
        `/project/${PROJECT}/intents/map`,
        createElement(AsksPack, {
          model,
          read: status === "ready" ? { status, trees } : { status },
          focus,
          onFocus: () => {},
          onOpenIntent: () => {},
          kit: { hierarchy, pack },
        }),
        "view=asks",
      ),
    );
  const root = render(null);
  assert.match(root, /<nav aria-label="Where you are"/);
  assert.match(text(root), /All intents Click an intent to see what its asks are for/);
  assert.match(
    text(root),
    /Intent What they ask for Ways people ask it Size is asks/,
    "a legend of the three circles",
  );
  assert.doesNotMatch(root, /Open the intent/);

  const inOrder = render("i:t_order");
  assert.match(text(inOrder), new RegExp(`All intents ${NAMES.t_order} Open the intent`));
  const inGroup = render("g:t_order:g_cancel");
  assert.match(text(inGroup), /“cancel order 1042”/, "a thing no model named is its ask, quoted");
  assert.match(inGroup, /aria-current="location"/);
  const renamed = render("g:t_order:gone");
  assert.match(
    text(renamed),
    new RegExp(`All intents ${NAMES.t_order} Open the intent`),
    "a group a rebuild renamed falls back to its intent",
  );

  assert.match(text(render(null, "loading")), /Reading what each intent's asks are for/);
  assert.match(text(render(null, "failed")), /Couldn't read what these intents' asks are for/);
  for (const html of [root, inOrder, inGroup]) {
    assertNoAskInAttributes(html);
    assertCalm(html);
    assertIntentsWords(html);
  }
});

test("in the Asks lens a rest says what it stands for, and a thing asked one way is picked, not entered", () => {
  const data = reading() as Extract<IntentsReading, { status: "ready" }>;
  const model = topicMapModel(data.view, data.tools);
  const oneThing = {
    topicId: "t_order",
    asks: 40,
    read: 40,
    capped: false,
    skipped: true,
    groups: [
      {
        id: "g",
        label: "Track an order",
        quoted: false,
        asks: 40,
        ways: [
          { id: "c1", label: ASKS.way, asks: 30 },
          { id: "c2", label: ASKS.second, asks: 6 },
        ],
        restAsks: 4,
        restWays: 3,
      },
    ],
    restAsks: 0,
    restGroups: 0,
  };
  const several = {
    topicId: "t_rent",
    asks: 20,
    read: 20,
    capped: false,
    skipped: false,
    groups: [
      {
        id: "g1",
        label: "Rent a lift",
        quoted: false,
        asks: 12,
        ways: [
          { id: "c3", label: "rent a lift", asks: 8 },
          { id: "c4", label: "book a lift", asks: 4 },
        ],
        restAsks: 0,
        restWays: 0,
      },
      {
        id: "g2",
        label: "Return a lift",
        quoted: false,
        asks: 5,
        ways: [],
        restAsks: 0,
        restWays: 0,
      },
    ],
    restAsks: 3,
    restGroups: 2,
  };
  const trees = new Map([
    ["t_order", oneThing],
    ["t_rent", several],
  ]);
  const layout = layoutAsks(
    model.asks.map((ask) => ({ id: ask.id, asks: ask.volume })),
    trees,
    { hierarchy, pack },
  );
  const named = (key: string) => nameOf(layout.byKey.get(key)!, model, trees).text;
  assert.equal(
    named("r:i:t_order"),
    "3 more ways",
    "an intent that is one thing: its rest is ways",
  );
  assert.equal(named("r:i:t_rent"), "2 more things");
  assert.equal(opens(layout, layout.byKey.get("g:t_rent:g1")!), true);
  assert.equal(
    opens(layout, layout.byKey.get("g:t_rent:g2")!),
    false,
    "asked one way: nothing to go into",
  );
  assert.equal(opens(layout, layout.byKey.get("w:t_order:g:c1")!), false);
});
