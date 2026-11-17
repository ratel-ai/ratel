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
import { CallSections, RawRequest } from "@/components/console/session-chat/StepInspector";
import { SessionTimeline } from "@/components/console/session-replay/SessionTimeline";
import {
  buildSessionTimeline,
  type TimelineLedgerStep,
  type TimelineModelCall,
  type TimelineTurn,
} from "@/lib/views/session-replay/timeline";
import { buildSessionView } from "@/lib/views/session-replay/view";
import { parseCallPayload } from "./inspect";
import { buildSessionChat, type ChatCallText, type SessionChat } from "./model";

/** RC-282: the session chat, rendered as the page renders it. */

const PATH = "/project/p1/sessions/s1";
const T0 = Date.parse("2026-10-02T13:43:00Z");
const at = (ms: number) => new Date(T0 + ms);

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

function step(
  ordinal: number,
  ms: number,
  kind: "search" | "invoke",
  targetId: string | null,
  outcome: string | null,
  tookMs: number,
): TimelineLedgerStep {
  return {
    ordinal,
    kind,
    traceEventId: `ev-${ordinal}-${ms}`,
    occurredAt: at(ms),
    eventPresent: true,
    targetType: kind === "invoke" ? "tool" : null,
    targetId,
    outcome,
    tookMs,
    searchType: kind === "search" ? "search" : null,
    hitCount: null,
    hitIds: null,
  };
}

function call(eventId: string, turnId: string, ms: number, latencyMs: number): TimelineModelCall {
  return {
    eventId,
    turnId,
    occurredAt: at(ms),
    model: "claude-opus-5-5",
    finishReason: "stop",
    inputTokens: 2000,
    outputTokens: 40,
    cachedTokens: 0,
    costUsd: 0.0073,
    latencyMs,
    hasContent: true,
  };
}

const TURNS: TimelineTurn[] = [
  {
    id: "t1",
    startedAt: at(0),
    endedAt: at(11_000),
    endedBy: "next_turn",
    abandoned: false,
    detour: false,
    reSearchCount: 0,
    steps: [
      step(1, 2_500, "search", null, null, 154),
      step(2, 3_000, "invoke", "find_booking", "ok", 710),
      step(3, 5_000, "invoke", "get_seat_map", "error", 1_300),
      step(4, 7_000, "invoke", "get_seat_map", "ok", 316),
    ],
  },
  {
    id: "t2",
    startedAt: at(120_000),
    endedAt: at(124_000),
    endedBy: "idle",
    abandoned: false,
    detour: false,
    reSearchCount: 0,
    steps: [],
  },
];
const CALLS = [
  call("c1", "t1", 200, 2_300),
  call("c2", "t1", 8_000, 1_600),
  call("c3", "t2", 121_000, 1_200),
];
const TEXTS = new Map<string, ChatCallText>([
  ["c1", { ask: "Can I move to an aisle seat?", reply: null }],
  ["c2", { ask: null, reply: "Done. You are now in 14C." }],
  ["c3", { ask: "Thanks!", reply: "Have a good flight." }],
]);

function render(search: string, texts: Map<string, ChatCallText> | null = TEXTS): string {
  const timeline = buildSessionTimeline({
    sessionId: "s1",
    turns: TURNS,
    modelCalls: CALLS,
    selfCorrections: [],
  });
  const chat = buildSessionChat({ timeline, turns: TURNS, texts });
  return renderToStaticMarkup(
    inRouter(
      search,
      createElement(SessionChatView, {
        projectId: "p1",
        chat,
        settingsHref: "/project/p1/settings",
      }),
    ),
  );
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

test("person messages on the right, replies on the left, one work line per turn", () => {
  const html = render("");
  assert.equal(count(html, 'data-chat-bubble="person"'), 2);
  assert.equal(count(html, 'data-chat-bubble="agent"'), 2);
  assert.match(html, /data-chat-bubble="person"[^>]*class="[^"]*self-end/);
  assert.match(html, /data-chat-bubble="agent"[^>]*class="[^"]*self-start/);
  assert.ok(html.includes("Can I move to an aisle seat?"));
  assert.ok(html.includes("Done. You are now in 14C."));
  assert.equal(count(html, "data-work-line="), 2);
  assert.ok(html.includes("4 actions · 11 s"));
  assert.ok(html.includes("2 to check"));
  assert.ok(html.includes("No actions · 4 s"));
  assert.ok(html.includes("Friday 2 October"));
  assert.equal(html.includes("data-chat-panel"), false);
});

test("?peek=work:1 opens the work-line panel beside the chat: steps and where the time went", () => {
  const html = render("?peek=work:1");
  assert.ok(html.includes('data-chat-panel="work"'));
  assert.ok(html.includes("4 actions, 2 to check"));
  assert.equal(count(html, "data-work-step="), 6);
  assert.ok(html.includes("Searched for a tool"));
  assert.ok(html.includes("Called find_booking"));
  assert.ok(html.includes("154 ms"));
  assert.ok(html.includes("Where the time went"));
  assert.ok(html.includes("Thinking"));
  assert.ok(html.includes("Tool search"));
  assert.ok(
    html.includes('aria-pressed="true" data-work-line="1"') ||
      /data-work-line="1"[^>]*aria-pressed="true"/.test(html),
  );
});

test("?peek=reply:1 shows the message in full; ?peek=step:5 shows one step and why it was flagged", () => {
  assert.ok(render("?peek=reply:1").includes('data-chat-panel="reply"'));
  const step = render("?peek=step:5");
  assert.ok(step.includes('data-chat-panel="step"'));
  assert.ok(step.includes("Called get_seat_map"));
  assert.ok(step.includes("Failed"));
});

test("an unknown peek opens nothing", () => {
  assert.equal(render("?peek=nope").includes("data-chat-panel"), false);
});

test("text off: the same bubbles without words, and where an admin turns it on", () => {
  const html = render("", null);
  assert.equal(count(html, 'data-chat-bubble="person"'), 2);
  assert.equal(count(html, 'data-chat-bubble="agent"'), 2);
  assert.equal(html.includes("aisle seat"), false);
  assert.ok(html.includes("Message text is off for this project"));
  assert.ok(html.includes('href="/project/p1/settings"'));
  assert.ok(html.includes("4 actions · 11 s"));
});

test("flag off: the page's step-by-step view renders as today, with no chat", () => {
  const timeline = buildSessionTimeline({
    sessionId: "s1",
    turns: TURNS,
    modelCalls: CALLS,
    selfCorrections: [],
  });
  const view = buildSessionView(timeline, {
    calls: [],
    bloatStartStep: null,
    unusedTools: [],
    missingTools: [],
    annotations: [],
    gaps: ["no_window_size"],
  });
  const whatIf = {
    projectId: "p1",
    targets: {},
    runs: [],
    options: { fixes: [], tools: [] },
    readContent: false,
  };
  const html = renderToStaticMarkup(
    inRouter("", createElement(SessionTimeline, { view, texts: {}, whatIf })),
  );
  assert.ok(html.length > 0);
  assert.equal(html.includes("data-chat-bubble"), false);
  assert.equal(html.includes("data-work-line"), false);
});

/* --- RC-283: the track, the playhead and the live action list ---------------- */

test("the track: one block per step, waits hatched with their real time, the legend", () => {
  const html = render("");
  assert.ok(html.includes("data-session-track"));
  assert.equal(count(html, 'data-segment="model_call"'), 3);
  assert.equal(count(html, 'data-segment="tool_call"'), 3);
  assert.equal(count(html, 'data-segment="search"'), 1);
  assert.equal(count(html, 'data-segment="wait"'), 1);
  assert.ok(html.includes("2 min later"));
  assert.ok(html.includes("Waiting for them, shortened"));
  assert.ok(html.includes("Next problem"));
  assert.ok(html.includes("Drag, scroll or use ← → to move through it"));
});

test("block widths follow durations: the 2.3 s call is wider than the 154 ms search", () => {
  const html = render("");
  const width = (kind: string, step: number) =>
    Number(
      new RegExp(`data-segment="${kind}" data-step="${step}"[^>]*width:([0-9.]+)%`).exec(html)?.[1],
    );
  assert.ok(width("model_call", 2) > width("search", 3) * 5);
});

test("?t= mid-turn: the live action list with the current step and a running timer, no reply yet", () => {
  // Turn 1 track: ask 0–300, call 500–2800, search 2800–3100 (154 ms, drawn at the 300 ms minimum), find_booking 3446–4156, …
  const html = render("?t=3500");
  assert.ok(html.includes('data-action-list="live"'));
  assert.ok(html.includes("Working"));
  assert.equal(count(html, 'data-action-row="done"'), 2);
  assert.equal(count(html, 'data-action-row="running"'), 1);
  assert.ok(html.includes("Called find_booking"));
  assert.equal(html.includes("Done. You are now in 14C."), false);
  assert.equal(html.includes("Have a good flight."), false);
  assert.equal(count(html, 'data-chat-bubble="person"'), 1);
  assert.ok(html.includes('aria-valuenow="3500"'));
});

test("at the end the turns collapse into work lines; no ?t= is the end", () => {
  const html = render("");
  assert.equal(html.includes("data-action-list"), false);
  assert.equal(count(html, "data-work-line="), 2);
});

test("?zoom=4 presses 4×, and the view follows the playhead", () => {
  const html = render("?zoom=4&t=3000");
  assert.match(html, /aria-pressed="true"[^>]*>4×</);
  assert.ok(html.includes("data-playhead"));
  assert.match(html, /data-playhead[^>]*left:50%/);
});

/* --- RC-284: the context inspector and the tool step ------------------------- */

function renderChat(
  search: string,
  texts: Map<string, ChatCallText> | null,
  splits?: SessionChat["splits"],
): string {
  const timeline = buildSessionTimeline({
    sessionId: "s1",
    turns: TURNS,
    modelCalls: CALLS,
    selfCorrections: [],
  });
  const chat = {
    ...buildSessionChat({ timeline, turns: TURNS, texts }),
    ...(splits ? { splits } : {}),
  };
  return renderToStaticMarkup(
    inRouter(
      search,
      createElement(SessionChatView, {
        projectId: "p1",
        chat,
        settingsHref: "/project/p1/settings",
      }),
    ),
  );
}

const SPLIT = {
  inputTokens: 2_000,
  parts: {
    system: 860,
    skills: 0,
    memory: 0,
    tools_used: 200,
    tools_unused: 440,
    history: 80,
    tool_results: 340,
    user_input: 80,
  },
};

test("a model call: tokens, time, cost and the split; opt-in off reads no request and says so", () => {
  const html = renderChat("?peek=step:2", null, { 2: SPLIT });
  assert.ok(html.includes("Model call 1 of 3"));
  assert.ok(html.includes("data-call-numbers"));
  assert.ok(html.includes("2,000 tokens"));
  assert.ok(html.includes("2.3 s"));
  assert.ok(html.includes("$0.0073"));
  assert.ok(html.includes("data-call-split"));
  assert.ok(html.includes("System prompt"));
  assert.ok(html.includes("Tools never called"));
  assert.ok(html.includes("data-text-off-note"));
  assert.equal(html.includes("data-raw-request"), false);
  assert.equal(html.includes("data-call-sections"), false);
  assert.ok(html.includes("Follow the playhead"));
});

test("the sections: system prompt, skills, tools with Called here / Never called / New, messages with new ones, output, settings", () => {
  const first = parseCallPayload({
    system: '<skills><skill name="seats">x</skill></skills>',
    tools: [{ name: "find_booking" }],
    messages: [{ role: "user", content: "Aisle seat" }],
    input_message_count: 1,
    output: [
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "c1", name: "find_booking", arguments: { ref: "MRD4X7" } },
        ],
      },
    ],
  });
  const second = parseCallPayload({
    system: '<skills><skill name="seats">x</skill></skills>',
    tools: [{ name: "find_booking" }, { name: "get_seat_map" }, { name: "issue_meal_voucher" }],
    messages: [
      { role: "user", content: "Aisle seat" },
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "c1", name: "find_booking", arguments: { ref: "MRD4X7" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: '{"flight":"MR214"}' },
    ],
    input_message_count: 3,
    output: [
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "c2", name: "get_seat_map", arguments: { flight: "MR214" } },
        ],
      },
    ],
    settings: { temperature: 0.2 },
  });
  const html = renderToStaticMarkup(
    createElement(CallSections, {
      view: second,
      previous: first,
      sessionCalled: new Set(["find_booking", "get_seat_map"]),
    }),
  );
  for (const title of [
    "System prompt",
    "Skills",
    "Tools",
    "Messages",
    "What came back",
    "Settings",
  ])
    assert.ok(html.includes(`data-section="${title}"`), title);
  assert.ok(
    html.includes("Since the last call: +1 message · tools in: get_seat_map, issue_meal_voucher"),
  );
  assert.ok(html.includes("Called here"));
  assert.ok(html.includes("Never called"));
  assert.equal(count(html, 'data-new="true"'), 1);
  assert.ok(html.includes("seats"));
  assert.ok(html.includes("&quot;temperature&quot;: 0.2"));
});

test("the raw request is the stored payload as it is, with Copy", () => {
  const raw = {
    provider: "anthropic",
    model: "claude-opus-5-5",
    messages: [{ role: "user", content: "Aisle seat" }],
  };
  const html = renderToStaticMarkup(createElement(RawRequest, { raw }));
  assert.ok(html.includes("Copy"));
  assert.ok(html.includes(JSON.stringify(raw, null, 2).replaceAll('"', "&quot;")));
});

test("a tool step: why it was flagged, its arguments and result, and the call that chose it", () => {
  const html = renderChat("?peek=step:5", TEXTS);
  assert.ok(html.includes("data-tool-step"));
  assert.ok(html.includes("Failed"));
  assert.ok(html.includes("Arguments"));
  assert.ok(html.includes("Result"));
  assert.ok(html.includes("See what the model had when it chose this"));
  const off = renderChat("?peek=step:5", null);
  assert.ok(off.includes("arguments and results are not shown"));
});

test("a search step: its ranked results", () => {
  const html = renderChat("?peek=step:3", null);
  assert.ok(html.includes("data-search-step"));
  assert.ok(html.includes("Ranked results"));
});

/* --- RC-524: one replay, the inspector open by default ------------------------ */

function renderV3(search: string, extra: Partial<SessionChat> = {}, whatIf = false): string {
  const timeline = buildSessionTimeline({
    sessionId: "s1",
    turns: TURNS,
    modelCalls: CALLS,
    selfCorrections: [],
  });
  const chat = { ...buildSessionChat({ timeline, turns: TURNS, texts: null }), ...extra };
  const setup = whatIf
    ? {
        projectId: "p1",
        runs: [],
        options: {
          fixes: [],
          tools: [{ name: "get_seat_map", description: "Seats", searchable: "get_seat_map Seats" }],
        },
        readContent: false,
      }
    : undefined;
  return renderToStaticMarkup(
    inRouter(
      search,
      createElement(SessionChatView, {
        projectId: "p1",
        chat,
        settingsHref: "/project/p1/settings",
        synced: true,
        whatIf: setup,
      }),
    ),
  );
}

test("views v3: no ?peek= opens the inspector on the first model call, following the playhead", () => {
  const html = renderV3("");
  assert.ok(html.includes('data-chat-panel="step"'));
  assert.ok(html.includes("Model call 1 of 3"));
  assert.match(html, /<input[^>]*checked=""[^>]*>|data-state="checked"|aria-checked="true"/);
});

test("views v3: an explicit ?peek= wins over the default inspector", () => {
  assert.ok(renderV3("?peek=reply:1").includes('data-chat-panel="reply"'));
  const call = renderV3("?peek=step:7");
  assert.ok(call.includes("Model call 2 of 3"));
});

test("views v3: a model call offers What if… at its fork; a tool step shows its tool-choice verdicts", () => {
  const forks = {
    2: { turnId: "t1", call: 0 },
    7: { turnId: "t1", call: 1 },
    10: { turnId: "t2", call: 0 },
  };
  const verdicts = {
    5: [{ tone: "bad" as const, text: "At step 5 the call to get_seat_map failed." }],
  };
  const call = renderV3("", { forks, verdicts }, true);
  assert.ok(call.includes("data-call-what-if"));
  assert.ok(call.includes("What if…"));
  assert.equal(call.includes("data-step-verdicts"), false);
  const tool = renderV3("?peek=step:5", { forks, verdicts }, true);
  assert.ok(tool.includes("data-step-verdicts"));
  assert.ok(tool.includes('data-decision-chip="bad"'));
  assert.ok(tool.includes("At step 5 the call to get_seat_map failed."));
  assert.equal(renderV3("", { forks, verdicts }).includes("data-call-what-if"), false);
});

test("views v3: no ?t= plays from the first message; an explicit ?t= wins; flag off starts at the end", () => {
  const start = renderV3("");
  assert.ok(start.includes('aria-valuenow="0"'));
  assert.equal(count(start, 'data-chat-bubble="person"'), 1);
  assert.equal(count(start, "data-work-line="), 0);
  const mid = renderV3("?t=3500");
  assert.ok(mid.includes('aria-valuenow="3500"'));
  assert.ok(
    render("").includes(
      `aria-valuenow="${buildSessionChat({ timeline: buildSessionTimeline({ sessionId: "s1", turns: TURNS, modelCalls: CALLS, selfCorrections: [] }), turns: TURNS, texts: TEXTS }).trackTotalMs}"`,
    ),
  );
});

/* --- RC-646: the inspector's source and actions come from the page ----------- */

test("inspector actions: the page's actions show under the open step; Traces passes none", () => {
  const timeline = buildSessionTimeline({
    sessionId: "s1",
    turns: TURNS,
    modelCalls: CALLS,
    selfCorrections: [],
  });
  const chat = buildSessionChat({ timeline, turns: TURNS, texts: null });
  const seen: Array<string | null> = [];
  const html = renderToStaticMarkup(
    inRouter(
      "?peek=step:5",
      createElement(SessionChatView, {
        projectId: "p1",
        chat,
        settingsHref: "/project/p1/settings",
        synced: true,
        source: async () => ({ ok: true as const, content: null }),
        inspectorActions: (segment) => {
          seen.push(segment.label);
          return createElement("button", { type: "button" }, `Set the answer of ${segment.label}`);
        },
      }),
    ),
  );
  assert.ok(html.includes("data-inspector-actions"));
  assert.ok(html.includes("Set the answer of get_seat_map"));
  assert.deepEqual(seen, ["get_seat_map"]);
  assert.equal(renderV3("?peek=step:5").includes("data-inspector-actions"), false);
});
