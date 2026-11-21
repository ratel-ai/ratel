// First: lets node load the components' stylesheet imports, and gives the router contexts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { FixBody } from "@/components/console/self-corrections/Change";
import { DetailsBody } from "@/components/console/self-corrections/DetailsPanel";
import { fixAction, fixActions } from "@/components/console/self-corrections/fix-actions";
import { SelfCorrectionsView } from "@/components/console/self-corrections/SelfCorrectionsView";
import { findDsViolations } from "@/eslint-rules/ds-tokens.mjs";
import { unavailableSelfCorrectionsPage } from "@/lib/views/health/self-corrections/page-load";
import {
  type BuildInput,
  buildSelfCorrectionsPage,
  type CorrectionReads,
} from "@/lib/views/health/self-corrections/page-model";
import { NO_FILTERS } from "@/lib/views/health/self-corrections/paths";
import {
  attributeValues,
  render as renderWithRouter,
  visibleText,
} from "@/lib/views/tasks/test-support";

/**
 * The Self-corrections page, rendered: a calm read top to bottom (the hero,
 * where it happens, what the agent said, what to change), the words a
 * founder reads (no engine names, no old nouns, "intent" never "topic", no
 * em dashes, nothing under 12 px), every state, and no reply text in the
 * markup: an example's words are read on demand by the browser, never by
 * the server render.
 */

const PROJECT = "22222222-2222-4222-8222-222222222222";
const ROOT = `/project/${PROJECT}`;
const NOW = "2026-10-20T12:00:00.000Z";

function reads(over: Partial<CorrectionReads> = {}): CorrectionReads {
  return {
    run: {
      computedAt: "2026-10-20T11:00:00.000Z",
      trust: { runs: "all", sessions: true },
      turnsWithReplies: 12,
    },
    current: {
      turns: 400,
      groups: [
        {
          kind: "retry_after_error",
          phraseCategory: null,
          phrase: null,
          toolId: "update_task",
          workflowId: "wf-a",
          topicId: "t-1",
          events: 9,
        },
        {
          kind: "gave_up_after_error",
          phraseCategory: null,
          phrase: null,
          toolId: "link_pr",
          workflowId: null,
          topicId: null,
          events: 3,
        },
        {
          kind: "phrase",
          phraseCategory: "apology",
          phrase: "I'm sorry",
          toolId: "update_task",
          workflowId: "wf-a",
          topicId: "t-1",
          events: 4,
        },
      ],
      failedCalls: 12,
      recoveredCalls: 9,
    },
    buckets: [
      { bucket: 0, turns: 60, events: 3 },
      { bucket: 2, turns: 50, events: 2 },
      { bucket: 6, turns: 80, events: 6 },
    ],
    previous: { turns: 380, events: 10 },
    taskTurns: new Map([["wf-a", 120]]),
    topicTurns: new Map([["t-1", 90]]),
    examples: [
      {
        id: "ex-1",
        turnId: "turn-1",
        kind: "phrase",
        phraseCategory: "apology",
        phrase: "I'm sorry",
        toolId: "update_task",
        toolOutcome: "error",
        occurredAt: new Date("2026-10-20T09:00:00Z"),
        hasText: true,
        turnKey: `otlp:${"b".repeat(32)}`,
        focusEventId: null,
      },
      {
        id: "ex-2",
        turnId: "turn-2",
        kind: "gave_up_after_error",
        phraseCategory: null,
        phrase: null,
        toolId: "link_pr",
        toolOutcome: "error",
        occurredAt: new Date("2026-10-19T09:00:00Z"),
        hasText: false,
        turnKey: "declared:x",
        focusEventId: "ev-2",
      },
    ],
    issues: [
      {
        id: "sig-1",
        subjectKind: "tool",
        subjectKey: "update_task",
        claim: "The agent corrects itself after Update task in 8% of the turns that call it.",
        fix: "Make Update task fail with a clear message, or retry inside the tool.",
        pattern: "failed",
        topicId: null,
        severity: 0.3,
        fixTool: "update_task",
      },
      {
        id: "sig-2",
        subjectKind: "workflow",
        subjectKey: "wf-a",
        claim: "The agent takes back what search_docs found in 12% of Update work's runs.",
        fix: "Rewrite search_docs's searchable description.",
        pattern: "backtrack",
        topicId: null,
        severity: 0.2,
        fixTool: "search_docs",
      },
    ],
    sentiment: null,
    ...over,
  };
}

function model(over: Partial<CorrectionReads> = {}, input: Partial<BuildInput> = {}) {
  return buildSelfCorrectionsPage({
    projectId: PROJECT,
    windowDays: 7,
    filters: NO_FILTERS,
    reads: reads(over),
    names: {
      tools: new Map([["update_task", "Update task"]]),
      tasks: new Map([["wf-a", { name: "Update work", runs: 120 }]]),
      topics: new Map([["t-1", "Release tracking"]]),
    },
    ...input,
  });
}

const WINDOWS = [
  { href: "/a", label: "7 days", active: true },
  { href: "/b", label: "30 days", active: false },
];

function render(
  page: ReturnType<typeof model>,
  actions = fixActions(PROJECT, page.fixes, null),
  search = "",
): string {
  return renderWithRouter(
    createElement(SelfCorrectionsView, {
      model: page,
      windows: WINDOWS,
      clearHref: "/clear",
      now: NOW,
      actions,
    }),
    {
      pathname: `${ROOT}/health/self-corrections`,
      search,
    },
  );
}

const OLD_NOUNS =
  /\bworkflows?\b|tool craft|suggestions?\b|\bsignals?\b|\bjev\b|bm25|wilson|\btopics?\b/i;

function assertHouseRules(html: string, where: string) {
  const text = visibleText(html);
  assert.doesNotMatch(text, OLD_NOUNS, `${where}: the product's nouns only`);
  assert.doesNotMatch(html, /—/, `${where}: no em dash`);
  assert.doesNotMatch(
    html,
    /text-\[(9|10|11)px\]|class="[^"]*\buppercase\b/,
    `${where}: nothing under 12 px, no eyebrows`,
  );
  const violations = [...html.matchAll(/class="([^"]*)"/g)].flatMap((match) =>
    findDsViolations(match[1]!),
  );
  assert.deepEqual([...new Set(violations)], [], `${where}: semantic tokens only`);
  assert.ok(
    !attributeValues(html).some((value) => value.includes("Release tracking")),
    `${where}: an intent's name is never in an attribute`,
  );
}

/** Where each section's heading sits, in order. */
function order(html: string, titles: readonly string[]): number[] {
  return titles.map((title) =>
    html.search(new RegExp(`<h2[^>]*>(?:<span[^>]*>(?:<svg[^]*?</svg>)?)?${title}`)),
  );
}

test("the ready page reads top to bottom: the hero, where it happens, what the agent said, what to change", () => {
  const html = render(model());
  assertHouseRules(html, "ready");
  const text = visibleText(html);
  assert.match(html, /<h1[^>]*>Self-corrections<\/h1>/);
  assert.match(text, /Times the agent retried, switched tools, gave up or apologized\./);
  const at = order(html, ["Where it happens", "What the agent said", "What to change"]);
  assert.ok(
    at.every((index) => index > 0),
    `every section: ${at.join(", ")}`,
  );
  assert.deepEqual(
    [...at].sort((a, b) => a - b),
    at,
    "in that order",
  );
  assert.ok(html.indexOf("data-corrections-hero") < at[0]!, "the hero first");
});

test("the hero: per 100 turns with its change and trend, three small figures, the kinds as marks, details one click away", () => {
  const html = render(model());
  const hero = html.slice(html.indexOf("data-corrections-hero"), html.search(/<h2/));
  const text = visibleText(hero);
  assert.match(text, /Per 100 turns 4\.0/);
  assert.match(hero, /text-danger[^]*\+1\.4/, "more self-corrections reads as bad news");
  assert.match(hero, /role="img" aria-label="Per 100 turns, day by day"/, "its trend");
  for (const [label, value] of [
    ["Recovered", "75%"],
    ["Asked again", "0%"],
    ["Gave up", "3"],
  ]) {
    assert.match(
      hero,
      new RegExp(
        `data-hero-figure="${label === "Asked again" ? "Asked again next turn" : label}"[^]*?>${label}</dt><dd[^>]*>${value}</dd>`,
      ),
      label,
    );
  }
  assert.match(hero, /data-kind="retried"[^]*Retried[^]*9/);
  assert.match(hero, /data-kind="apologized"[^]*Apologized[^]*4/);
  assert.doesNotMatch(hero, /data-kind="switched"/, "a kind that did not happen is left out");
  assert.match(hero, /href="[^"]*\?peek=details"[^>]*>[^]*Details/);
  assert.doesNotMatch(
    text,
    /in the 7 days before|of failed calls/,
    "what each number counts is in the Panel",
  );
});

test("the details Panel: every number with what it counts, every kind with its meaning, and when it was read", () => {
  const page = model();
  const html = renderWithRouter(
    createElement(DetailsBody, {
      stats: page.stats,
      kinds: page.byKind,
      computedAt: page.computedAt,
      now: NOW,
    }),
  );
  assertHouseRules(`<h1></h1>${html}`, "details");
  const text = visibleText(html);
  assert.match(text, /Recovered 9 of 12 failed calls 75%/);
  assert.match(text, /Asked again next turn 0 of 400 turns 0%/);
  assert.match(
    text,
    /Retried after an error A tool call failed and the agent called the same tool again\. 9/,
  );
  assert.match(text, /Read 1 h ago|Read 60 min ago|Read an hour ago|Read 1 hour ago/);
});

test("where it happens: tools, tasks and intents as pins with bars, each narrowing the page to it", () => {
  const html = render(model());
  const where = html.slice(
    html.indexOf("data-corrections-where"),
    html.indexOf("data-corrections-said"),
  );
  const text = visibleText(where);
  assert.match(where, /data-where="tool"[^]*After a tool/);
  assert.match(where, /data-where="task"[^]*In a task/);
  assert.match(where, /data-where="intent"[^]*For an intent/);
  assert.match(
    where,
    new RegExp(
      `<a (?=[^>]*href="${ROOT}/health/self-corrections\\?tool=update_task")[^>]*>[^]*?lucide-wrench[^]*?Update task`,
    ),
    "a tool as its pin",
  );
  assert.match(
    where,
    new RegExp(
      `<a (?=[^>]*href="${ROOT}/health/self-corrections\\?task=wf-a")[^>]*>[^]*?bg-chart-1[^]*?Update work`,
    ),
    "a task as its pin, in its color",
  );
  assert.match(
    where,
    new RegExp(
      `<a (?=[^>]*href="${ROOT}/health/self-corrections\\?topic=t-1")[^>]*>[^]*?lucide-message-square-text[^]*?Release tracking`,
    ),
    "an intent as its pin",
  );
  assert.match(where, /role="meter"/);
  assert.match(text, /In no task 3/);
  const none = visibleText(
    render(
      model({
        topicTurns: new Map(),
        current: {
          ...reads().current,
          groups: reads().current.groups.map((group) => ({ ...group, topicId: null })),
        },
      }),
    ),
  );
  assert.match(
    none,
    /Intents show once people's asks are grouped\.|Intents show once people&#x27;s asks are grouped\./,
  );
});

test("what the agent said: top phrases beside the examples; an example's words are read on demand", () => {
  const html = render(model());
  const said = html.slice(html.indexOf("data-corrections-said"));
  const text = visibleText(said);
  assert.match(text, /Top phrases “I&#x27;m sorry” 4|Top phrases “I'm sorry” 4/);
  assert.match(
    text,
    /link_pr failed, and the agent stopped there\./,
    "a behaviour example says what happened",
  );
  assert.match(
    said,
    new RegExp(`href="${ROOT}/traces/${"b".repeat(32)}"`),
    "an example opens its trace",
  );
  assert.equal(
    (html.match(/animate-pulse/g) ?? []).length >= 2,
    true,
    "a phrase example waits for its words",
  );
  assert.doesNotMatch(html, /<mark/);
  const noReplies = visibleText(
    render(
      model({
        run: { computedAt: NOW, trust: { runs: "all", sessions: true }, turnsWithReplies: 0 },
        current: {
          ...reads().current,
          groups: reads().current.groups.filter((group) => group.kind !== "phrase"),
        },
      }),
    ),
  );
  assert.match(noReplies, /Turn on content capture to see what the agent said\./);
  assert.match(noReplies, /Phrases need content capture/, "the hero says what it cannot count");
});

test("what to change: each fix's mark, title and subject, a description update going to Quality › Descriptions", () => {
  const page = model();
  const html = render(page);
  const change = html.slice(html.indexOf("data-corrections-fixes"));
  assert.match(change, /data-corrections-fix="sig-1"[^]*data-fix-pattern="failed"/);
  assert.match(change, /data-corrections-fix="sig-2"[^]*lucide-pen-line/);
  assert.match(
    change,
    new RegExp(
      `<a (?=[^>]*href="${ROOT}/quality/descriptions\\?tool=search_docs")(?=[^>]*data-corrections-action="description")[^>]*>[^]*?Update description`,
    ),
  );
  assert.match(
    change,
    new RegExp(
      `<a (?=[^>]*href="${ROOT}/improvement/fixes\\?tool=update_task")(?=[^>]*data-corrections-action="fix")[^>]*>Fix`,
    ),
  );
  assert.match(
    change,
    new RegExp(`href="${ROOT}/health/tasks/wf-a"[^]*Update work`),
    "a task's fix shows the task's pin",
  );
  assert.doesNotMatch(
    visibleText(change),
    /corrects itself after Update task in 8%/,
    "why sits in the Panel",
  );

  // With Fixes read: the fix itself, Quality's rewrite of the tool, and Fixes' own short title.
  const lookups = [
    {
      id: "craft:9",
      aliases: ["issue:sig-1"],
      title: "Make Update task fail clearly",
      status: "open" as const,
      kind: "fail-clearly" as const,
      source: "craft" as const,
      toolIds: ["update_task"],
    },
    {
      id: "rewrite:rw-2",
      aliases: [],
      title: "Rewrite search_docs's searchable description",
      status: "open" as const,
      kind: "rewrite" as const,
      source: "rewrite" as const,
      toolIds: ["search_docs"],
    },
  ];
  const actions = fixActions(PROJECT, page.fixes, lookups);
  assert.deepEqual(actions["sig-1"], {
    kind: "fix",
    href: `${ROOT}/improvement/fixes?peek=craft%3A9`,
    title: "Make Update task fail clearly",
  });
  assert.deepEqual(actions["sig-2"], {
    kind: "description",
    href: `${ROOT}/quality/descriptions?peek=rewrite%3Arw-2`,
    title: null,
  });
  assert.match(visibleText(render(page, actions)), /Make Update task fail clearly/);
  assert.deepEqual(
    fixAction(PROJECT, page.fixes[1]!, null),
    { kind: "description", href: `${ROOT}/quality/descriptions?tool=search_docs`, title: null },
    "without Fixes: the tool",
  );

  const body = renderWithRouter(
    createElement(FixBody, { fix: page.fixes[0]!, action: actions["sig-1"] }),
  );
  assertHouseRules(`<h1></h1>${body}`, "fix panel");
  assert.match(
    visibleText(body),
    /Why The agent corrects itself after Update task in 8% of the turns that call it\./,
  );
  assert.match(body, new RegExp(`href="${ROOT}/health#signal-sig-1"[^>]*>See issue`));
});

test("filtered: the chips name the tool, task or intent, and each opens its own page", () => {
  const html = render(model({}, { filters: { tool: "update_task", task: "wf-a", topic: "t-1" } }));
  assertHouseRules(html, "filtered");
  const text = visibleText(html);
  assert.match(text, /After Update task/);
  assert.match(text, /Task Update work/);
  assert.match(text, /Intent Release tracking/);
  assert.match(
    html,
    new RegExp(
      `<a (?=[^>]*href="${ROOT}/catalogs/tools\\?q=update_task&amp;highlight=update_task")(?=[^>]*data-filter-open="tool")`,
    ),
  );
  assert.match(
    html,
    new RegExp(`<a (?=[^>]*href="${ROOT}/health/tasks/wf-a")(?=[^>]*data-filter-open="task")`),
  );
  assert.match(
    html,
    new RegExp(
      `<a (?=[^>]*href="${ROOT}/intents\\?peek=t-1")(?=[^>]*data-filter-open="topic")[^>]*>[^]*?Open intent`,
    ),
  );
});

test("every other state is designed", () => {
  const notRead = visibleText(render(model({ run: null })));
  assert.match(notRead, /No reading yet/);
  const mixed = visibleText(
    render(
      model({
        run: { computedAt: NOW, trust: { runs: "none", sessions: false }, turnsWithReplies: 0 },
      }),
    ),
  );
  assert.match(mixed, /Needs turn ids/);
  const empty = { current: { turns: 0, groups: [], failedCalls: 0, recoveredCalls: 0 } };
  assert.match(visibleText(render(model(empty))), /No runs this week/);
  const filtered = visibleText(
    render(model(empty, { filters: { tool: "update_task", task: null, topic: null } })),
  );
  assert.match(filtered, /No runs match these filters/);
  assert.match(filtered, /Update task/, "the filter chip names the tool");
  const quiet = visibleText(
    render(model({ current: { turns: 400, groups: [], failedCalls: 0, recoveredCalls: 0 } })),
  );
  assert.match(quiet, /No self-corrections this week/);
  const failed = visibleText(render(unavailableSelfCorrectionsPage(PROJECT, 7)));
  assert.match(failed, /Couldn&#x27;t load self-corrections|Couldn't load self-corrections/);
  for (const text of [notRead, mixed, quiet, failed]) assert.doesNotMatch(text, OLD_NOUNS);
});
