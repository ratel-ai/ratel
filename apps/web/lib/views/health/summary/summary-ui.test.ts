// First: lets node load the components' stylesheet imports, and gives the router contexts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { IssueDetail } from "@/components/console/health/v2/IssueDetail";
import { issueRows, rowOfIssue } from "@/components/console/health/v2/issue-rows";
import { SelfCorrectionsRow } from "@/components/console/health/v2/SelfCorrectionsRow";
import { SummarySkeleton } from "@/components/console/health/v2/SummarySkeleton";
import {
  SummaryNoDatabase,
  SummaryView,
  type SummaryViewProps,
} from "@/components/console/health/v2/SummaryView";
import { fixLookups } from "@/components/console/health/v2/summary-model";
import { AskExample } from "@/components/console/health/v2/UnservedSection";
import { findDsViolations } from "@/eslint-rules/ds-tokens.mjs";
import type { StoredSetup } from "@/lib/readings/trace-signals/setup-facts";
import {
  type FlowJourney,
  type HealthPageModel,
  type HealthTile,
  type WorkflowsView,
  windowOptionsForPlan,
} from "@/lib/readings/trace-signals/view";
import type { Fix } from "@/lib/views/fixes/types";
import { MOCK_HEALTH_MODEL, MOCK_NO_TELEMETRY } from "@/lib/views/health/mock-fixture";
import { pendingHealthModel } from "@/lib/views/health/page-model";
import type { HealthPageState } from "@/lib/views/health/page-state";
import type { SelfCorrectionsCardModel } from "@/lib/views/health/self-corrections/card";
import type { TaskListModel, TaskRow } from "@/lib/views/tasks/model";
import { attributeValues, render, visibleText } from "@/lib/views/tasks/test-support";

/**
 * Agent health's Summary as a reader sees it, in every state: the reading,
 * before one (nothing yet, collecting, being built, outside the window, no
 * tool calls, a read that failed), runs mixed together, and OpenTelemetry
 * or SDK runs. Each checks the house rules (DESIGN.md), the product's nouns
 * (never "topic"), and that what users wrote never sits in an attribute.
 *
 * Owned (ADR-0030): no importer, share link or plan link on the Summary.
 */

const PROJECT = "6b64f504-f84f-447a-afe4-fb84054735fb";
const ROOT = `/project/${PROJECT}`;
const NOW = new Date("2026-10-21T12:00:00Z");
const ASK = "export the whole board as a PDF for the client";
const CAPTURED = "find the onboarding tasks for Acme";

const WORKFLOWS: WorkflowsView = {
  items: [
    {
      id: "wf-release",
      name: "Ship a release",
      description: null,
      icon: "rocket",
      steps: [
        { id: "find_task", label: "find_task" },
        { id: "assign_task", label: "assign_task" },
      ],
      focusTools: ["find_task", "assign_task", "create_task"],
      runs: 300,
      share: 0.4,
      completion: 0.82,
      medianMs: 2_000,
      problem: null,
      build: null,
      failingStep: null,
      slowestStep: null,
      examples: [],
      stoppedShort: null,
    },
  ],
  multiToolTurns: 800,
  assignedTurns: 600,
  minTools: 2,
  minRuns: 5,
  chainOwners: {},
  unserved: [
    {
      title: ASK,
      others: ["make a pdf of the board"],
      runs: 4,
      reason: "no_tool",
      turnIds: ["turn-77"],
    },
  ],
  blocked: null,
  readingSince: null,
  excludedRuns: 0,
  asksFrom: "user",
};

function taskRow(id: string, name: string, status: TaskRow["status"], runs: number): TaskRow {
  return {
    id,
    name,
    description: "Finds the work and hands it over.",
    icon: "rocket",
    color: id === "wf-release" ? "chart-1" : null,
    status,
    runs,
    share: 0.3,
    finishRate: status === "healthy" ? 0.97 : 0.61,
    weakest:
      status === "healthy"
        ? null
        : {
            toolId: "assign_task",
            label: "assign_task",
            failures: 40,
            calls: 100,
            failureShare: 0.4,
          },
    correctionsPer100: 12,
    topics: null,
    issues: 1,
    fixes: 1,
    fixesHref: `${ROOT}/improvement/fixes?task=${id}`,
  };
}

const TASKS: TaskListModel = {
  state: "ready",
  blocked: null,
  windowDays: 30,
  readAt: NOW,
  stats: {
    tasks: 2,
    runsInTasks: 400,
    allRuns: 1_284,
    finishRate: 0.8,
    correctionsPer100: 12,
    correctionsRecorded: true,
  },
  rows: [
    taskRow("wf-release", "Ship a release", "failing", 300),
    taskRow("wf-browse", "Browse the board", "healthy", 100),
  ],
  unserved: { measured: true, asks: [], runs: 0 },
  readingSince: null,
  excludedRuns: 0,
};

function fix(
  id: string,
  issue: string,
  title: string,
  kind: string,
  source: string,
  tools: string[],
): Fix {
  return {
    id,
    aliases: [`issue:${issue}`],
    title,
    status: "open",
    kind,
    source,
    subject: { tools: tools.map((tool) => ({ id: tool })), tasks: [], topics: [] },
  } as unknown as Fix;
}

/** A description update drafted for the magnet: made on Quality › Descriptions, on its tool. */
const FIX = fix(
  "craft:fx-1",
  "sig-magnet-create-task",
  "Narrow create_task's searchable description",
  "rewrite",
  "craft",
  ["create_task"],
);
/** Quality's own rewrite: opens in Quality's panel. */
const REWRITE = fix(
  "rewrite:rw-1",
  "sig-first-try-assign",
  "Rewrite assign_task's searchable description",
  "rewrite",
  "rewrite",
  ["assign_task"],
);
/** Any other fix opens on Fixes. */
const COMBINE = fix(
  "craft:fx-2",
  "sig-chain-find-assign",
  "Combine find_task and assign_task",
  "combine",
  "craft",
  ["find_task", "assign_task"],
);

const CARD: SelfCorrectionsCardModel = {
  state: "ready",
  windowDays: 7,
  rate: {
    label: "Per 100 turns",
    value: "19.4",
    hint: "21.1 in the 7 days before",
    delta: { value: "-1.7", direction: "down", good: true, label: "vs the 7 days before" },
  },
  events: 58,
  turns: 298,
  topTool: {
    node: "assign_task",
    entryId: "assign_task",
    entryKind: "tool",
    name: "assign_task",
    events: 32,
    mainKind: "Switched tools",
    href: `${ROOT}/health/self-corrections?days=7&tool=assign_task`,
  },
  href: `${ROOT}/health/self-corrections?days=7`,
  trend: {
    values: [21, 18, null, 20, 19, 22, 19.4],
    bucketDays: 1,
    label: "Per 100 turns, day by day",
  },
  recovered: { label: "Recovered", value: "68%", hint: "25 of 37 failed calls" },
  recoveredShare: 25 / 37,
  topPhrase: { phrase: "I'm sorry", events: 6 },
  phrasesCaptured: true,
};

const SETUP: StoredSetup = {
  version: 1,
  lanes: { sdk: true, otel: false },
  facts: [
    { key: "sdk_tool_calls", status: "on", share: 1 },
    { key: "sdk_turn_ids", status: "off", share: 0 },
    { key: "sdk_user_messages", status: "partial", share: 0.42 },
  ],
};

/** Every turn call by call: find_task almost always runs before assign_task. */
const JOURNEY: FlowJourney = {
  steps: 3,
  turns: 120,
  paths: [
    { start: "none", tools: ["find_task", "assign_task"], end: "ended", turns: 70 },
    { start: "none", tools: ["create_task"], end: "ended", turns: 30 },
    {
      start: "search",
      tools: ["find_task", "assign_task", "create_task"],
      end: "ended",
      turns: 20,
    },
  ],
  tools: ["find_task", "assign_task", "create_task"].map((id) => ({
    id,
    kind: "tool" as const,
    label: id,
    tint: "none" as const,
    signalIds: id === "create_task" ? ["sig-magnet-create-task"] : [],
    flags: [],
  })),
  otherTools: [0, 0, 0],
  searchSignalIds: [],
};

const READY_MODEL: HealthPageModel = {
  ...MOCK_HEALTH_MODEL,
  flow: { ...MOCK_HEALTH_MODEL.flow, journey: JOURNEY },
  workflows: WORKFLOWS,
  setup: SETUP,
  evidenceTurnsPerSignal: 6,
};

function props(over: Partial<SummaryViewProps> = {}): SummaryViewProps {
  return {
    projectId: PROJECT,
    projectName: "Site Copilot",
    model: READY_MODEL,
    state: { kind: "ready" },
    windowOptions: windowOptionsForPlan(30),
    tasks: TASKS,
    fixes: { open: [FIX, REWRITE, COMBINE], applied: [] },
    corrections: CARD,
    reportHref: `/report/health/${PROJECT}?days=7&print=1`,
    now: NOW,
    ...over,
  };
}

function page(over: Partial<SummaryViewProps> = {}, search = ""): string {
  return render(createElement(SummaryView, props(over)), { pathname: `${ROOT}/health`, search });
}

/** DESIGN.md's rules and the product's nouns, on every render. */
function assertHouseStyle(html: string, where: string) {
  const text = visibleText(html);
  assert.doesNotMatch(text, /\u2014/, `${where}: no em dash`);
  assert.doesNotMatch(
    html,
    /text-\[(?:9|10|11)(?:\.\d+)?px\]|uppercase tracking|class="[^"]*\buppercase\b/,
    `${where}: nothing under 12 px, no eyebrows`,
  );
  assert.doesNotMatch(
    text,
    /\b[Ww]orkflows?\b|Tool craft|\b[Ss]uggestions?\b|\b[Ss]ignals?\b|\b[Pp]roblems?\b|Worth a look|\b[Tt]opics?\b|Needs first/,
    `${where}: the product's nouns only`,
  );
  const violations = [...html.matchAll(/class="([^"]*)"/g)].flatMap((match) =>
    findDsViolations(match[1]!),
  );
  assert.deepEqual([...new Set(violations)], [], `${where}: semantic tokens only`);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1, `${where}: one h1`);
  for (const secret of [ASK, "make a pdf of the board", CAPTURED]) {
    assert.ok(
      !attributeValues(html).some((value) => value.includes(secret)),
      `${where}: what users wrote is never in an attribute`,
    );
  }
}

/** Where each section's heading sits in the page, in order. */
function headingOrder(html: string, titles: readonly string[]): number[] {
  return titles.map((title) =>
    html.search(new RegExp(`<h2[^>]*>(?:<span[^>]*>(?:<svg[^]*?</svg>)?)?${title}`)),
  );
}

test("the reading, in its order: readings, turn shapes, issues, self-corrections, tasks, call order, chains, requests", () => {
  const html = page();
  assertHouseStyle(html, "ready");
  const text = visibleText(html);
  assert.match(html, /<h1[^>]*>Agent health<\/h1>/);
  assert.match(
    text,
    /What Site Copilot gets wrong this week, from 1,284 turns through the Ratel SDK\./,
  );
  assert.match(html, /data-health-page-state="ready"/);
  const order = headingOrder(html, [
    "Turn shapes",
    "Issues",
    "Self-corrections",
    "Tasks that need a look",
    "What your agent calls first",
    "Common chains",
    "Asks no task handles",
  ]);
  assert.ok(
    order.every((at) => at > 0),
    `every section is there: ${order.join(", ")}`,
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    "in the page's order",
  );
  assert.ok(html.indexOf("data-health-readings") < order[0]!, "the readings first");

  // The window as links, the plan's longest one locked with the plan that has it.
  assert.match(
    html,
    new RegExp(`<a (?=[^>]*aria-current="true")(?=[^>]*href="${ROOT}/health")[^>]*>7\\sdays</a>`),
  );
  assert.match(html, new RegExp(`href="${ROOT}/health\\?days=30"`));
  // Owned: a window outside the limits is locked without a plan name; the menu holds the report alone.
  assert.match(html, /data-health-window-locked="90"[^]*90 days[^]*, not included/);
  assert.match(html, /aria-label="Download"/, "one header menu");

  // The readings, in plain words, with their change; self-corrections are no reading of their own.
  for (const label of ["First try", "Detours", "Junk in lists", "Wasted calls per 100 turns"]) {
    assert.match(html, new RegExp(`<dt[^>]*>(?:<a[^>]*>)?${label}(?:</a>)?</dt>`), label);
  }
  assert.doesNotMatch(html, />Self-corrections per 100 turns</);
  assert.match(html, /href="[^"]*\?peek=reading%3Afirst_try"/, "a reading opens its numbers");

  // Turn shapes: a picture, a name, a share; the sentence is read aloud, not shown.
  assert.match(html, /data-shape-pictogram="direct"/);
  assert.match(html, /<span class="sr-only">: /);

  // The one Callout: what to turn on, each chip opening its guide.
  assert.match(html, /role="note"[^]*2 settings missing/);
  assert.match(html, /href="[^"]*\?peek=setup%3Asdk_turn_ids"[^>]*>[^]*Turn ids[^]*Not sent/);
  assert.match(html, /Partly sent, 42%/);
});

test("issues: one list, each row only its kind's icon, title, status, one number and the way forward", () => {
  const html = page();
  const text = visibleText(html);
  assert.match(
    html,
    /<h2[^>]*>(?:<span[^>]*>)?<svg[^>]*lucide-circle-alert/,
    "the issue noun's mark on the heading",
  );
  assert.match(text, /12 issues across \d+ tools, worst first\. 2 more are too early to call\./);
  assert.equal((html.match(/data-issue-row=/g) ?? []).length, 5, "five, then the rest");
  assert.match(html, /data-show-all-issues=""[^>]*>Show all 14 issues</);
  assert.match(
    html,
    /id="signal-sig-no-follow-search-projects"/,
    "a hidden row's link target is still there",
  );
  assert.match(html, /data-issue-icon="magnet"/, "the kind's icon");
  assert.match(html, /Wrong tool keeps showing up/);

  // No chips on a row: the tools and the task live in the panel.
  const issues = html.slice(
    html.search(/<h2[^>]*>(?:<span[^>]*>)?(?:<svg[^]*?<\/svg>)?Issues/),
    html.search(/data-health-corrections=/),
  );
  assert.doesNotMatch(
    issues,
    /lucide-wrench|data-issue-task=|Ship a release/,
    "no tool or task chips on the rows",
  );

  // A description update says so and goes to Quality › Descriptions.
  assert.match(
    html,
    new RegExp(
      `<a (?=[^>]*href="${ROOT}/quality/descriptions\\?tool=create_task")(?=[^>]*data-issue-action="description")[^>]*>[^]*?Update description<span class="sr-only">: Narrow create_task&#x27;s searchable description</span>`,
    ),
  );
  assert.match(
    html,
    new RegExp(
      `<a (?=[^>]*href="${ROOT}/quality/descriptions\\?peek=rewrite%3Arw-1")(?=[^>]*data-issue-action="description")`,
    ),
    "Quality's own rewrite in its panel",
  );
  // Any other fix opens on Fixes; no fix, its turns.
  assert.match(
    html,
    new RegExp(
      `<a (?=[^>]*href="${ROOT}/improvement/fixes\\?peek=craft%3Afx-2")(?=[^>]*data-issue-action="fix")[^>]*>Fix<span class="sr-only">: Combine find_task and assign_task</span>`,
    ),
  );
  assert.match(html, /data-issue-action="turns"[^>]*>See turns/);
  assert.ok(
    !text.includes(CAPTURED),
    "an example turn is read when its issue is opened, never with the page",
  );
});

test("self-corrections: their own row, the headline only, and the way to the page", () => {
  const html = render(createElement(SelfCorrectionsRow, { model: CARD }), {
    pathname: `${ROOT}/health`,
  });
  assertHouseStyle(`<h1></h1>${html}`, "self-corrections row");
  const text = visibleText(html);
  assert.match(
    html,
    /<h2[^>]*>(?:<span[^>]*>)?<svg[^>]*lucide-rotate-ccw[^]*Self-corrections/,
    "the self-correction noun's mark",
  );
  assert.match(
    html,
    new RegExp(
      `<a (?=[^>]*href="${ROOT}/health/self-corrections\\?days=7")(?=[^>]*data-corrections-open="")[^>]*>See self-corrections`,
    ),
  );
  for (const label of ["Per 100 turns", "Recovered", "Most after", "Top phrase"])
    assert.match(html, new RegExp(`>${label}<`), label);
  assert.match(text, /19\.4/);
  assert.match(html, /role="img" aria-label="Per 100 turns, day by day"/, "its trend");
  assert.match(text, /68%/);
  assert.match(
    html,
    new RegExp(
      `<a (?=[^>]*href="${ROOT}/health/self-corrections\\?days=7&amp;tool=assign_task")[^>]*>[^]*?assign_task`,
    ),
    "the top tool as a pin that narrows the page",
  );
  assert.match(text, /“I&#x27;m sorry”|“I'm sorry”/);
  assert.match(text, /6 times/);

  const none = visibleText(
    render(createElement(SelfCorrectionsRow, { model: { ...CARD, events: 0 } })),
  );
  assert.match(none, /None this week/);
  const capture = visibleText(
    render(
      createElement(SelfCorrectionsRow, {
        model: { ...CARD, topPhrase: null, phrasesCaptured: false },
      }),
    ),
  );
  assert.match(capture, /Needs content capture/, "without captured replies it says what it needs");
  for (const [state, words] of [
    ["unavailable", /Couldn't load self-corrections|Couldn&#x27;t load self-corrections/],
    ["not_read", /after the next reading/],
    ["mixed_runs", /Needs turn ids/],
    ["no_turns", /No runs in this window/],
  ] as const) {
    assert.match(
      render(createElement(SelfCorrectionsRow, { model: { ...CARD, state } })),
      words,
      state,
    );
  }
});

test("tasks that need a look: the task as its pin, its weakest step as a tool pin with how often it fails", () => {
  const html = page();
  assert.match(html, new RegExp(`href="${ROOT}/health/tasks"[^>]*>All tasks`));
  assert.match(
    html,
    new RegExp(
      `data-task-row="wf-release"[^>]*><a (?=[^>]*href="${ROOT}/health/tasks/wf-release")[^>]*>[^]*?bg-chart-1[^]*?Ship a release`,
    ),
    "the task in its color",
  );
  assert.match(html, /data-task-weakest="assign_task"[^]*lucide-wrench[^]*assign_task[^]*40% fail/);
  assert.doesNotMatch(html, /data-task-row="wf-browse"/, "a healthy task is not here");
});

/** find_task runs before assign_task in all its turns, and seldom otherwise: a pair "What comes before" keeps. */
const PAIRED: FlowJourney = {
  ...JOURNEY,
  turns: 150,
  paths: [
    { start: "none", tools: ["find_task", "assign_task"], end: "ended", turns: 30 },
    { start: "none", tools: ["create_task"], end: "ended", turns: 100 },
    {
      start: "search",
      tools: ["find_task", "assign_task", "create_task"],
      end: "ended",
      turns: 20,
    },
  ],
};

test("the call order: plain words for its views, the lane it was read from, and chains named by their task", () => {
  const html = page({ model: { ...READY_MODEL, flow: { ...READY_MODEL.flow, journey: PAIRED } } });
  const text = visibleText(html);
  assert.match(html, /<h2[^>]*>[^]*What your agent calls first[^]*data-journey-canvas="true"/);
  assert.match(html, /data-call-order-source="sdk"[^]*Read from[^]*Ratel SDK/, "the SDK lane");
  assert.match(text, /What comes before/);
  assert.match(text, /Every call/);
  assert.doesNotMatch(text, /Needs first/);
  // Chains: only those that are a task, by its pin, with their turns and share.
  assert.match(html, /data-journey-chains="1"/);
  assert.match(
    html,
    new RegExp(
      `data-chain-task="wf-release"[^]*href="${ROOT}/health/tasks/wf-release"[^]*Ship a release[^]*20 turns · 13%`,
    ),
  );
  assert.match(
    html,
    /data-prereq-line=""[^]*lucide-hammer[^]*Say so in the tool/,
    "what to do, marked as a fix",
  );
  assert.doesNotMatch(
    html.slice(html.indexOf("data-journey-chains")),
    /lucide-chevron-right[^]*find_task/,
    "no raw tool list",
  );

  const otel = page({ model: { ...READY_MODEL, sourceMode: "otel" } });
  assert.match(otel, /data-call-order-source="otel"[^]*OpenTelemetry/);
  const noTask = page({
    tasks: { ...TASKS, rows: [] },
    model: { ...READY_MODEL, workflows: { ...WORKFLOWS, items: [] } },
  });
  assert.doesNotMatch(noTask, /Common chains/, "no chain is a task: the section is dropped");
});

test("asks no task handles: compact rows, the example on a click", () => {
  const html = page();
  const text = visibleText(html);
  assert.match(html, /<h2[^>]*>[^]*Asks no task handles/);
  assert.match(text, /1 ask · 4 runs/);
  assert.match(
    html,
    /data-unserved-ask="0"[^]*lucide-wrench-off[^]*4 runs/,
    "why, as an icon, and how often",
  );
  assert.ok(text.includes(ASK), "what was asked, as text");
  assert.doesNotMatch(html, /make a pdf of the board/, "the example waits for a click");
  assert.doesNotMatch(html, new RegExp(`href="${ROOT}/traces/turns/turn-77"`));

  const example = render(
    createElement(AskExample, { projectId: PROJECT, ask: WORKFLOWS.unserved[0]! }),
  );
  assertHouseStyle(`<h1></h1>${example}`, "request example");
  assert.match(visibleText(example), /Also asked: “make a pdf of the board”/);
  assert.match(visibleText(example), /No tool does this\. 4 runs\./);
  assert.match(example, new RegExp(`href="${ROOT}/traces/turns/turn-77"`));
});

/** The detail a row's Panel holds (a Panel renders in a portal, so the detail is rendered on its own here). */
function detail(
  signalId: string,
  over: { examplesAllowed?: boolean; fixes?: SummaryViewProps["fixes"] } = {},
): string {
  const rows = issueRows({
    projectId: PROJECT,
    signals: READY_MODEL.signals,
    tooEarly: READY_MODEL.tooEarly,
    folding: undefined,
    tasks: [],
    fixes: fixLookups(
      over.fixes === undefined ? { open: [FIX, REWRITE, COMBINE], applied: [] } : over.fixes,
    ),
  });
  const row = rowOfIssue(rows, signalId)!;
  return render(
    createElement(IssueDetail, {
      projectId: PROJECT,
      row,
      initialMemberId: signalId,
      examplesAllowed: over.examplesAllowed ?? true,
      upgradeHref: null,
      focusExamples: false,
      cache: new Map(),
    }),
    { pathname: `${ROOT}/health` },
  );
}

test("an issue's detail: its tools and task as pins, what to do, the fix that does it, why, and its turns read when opened", () => {
  const html = detail("sig-magnet-create-task");
  assertHouseStyle(`<h1></h1>${html}`, "issue detail");
  assert.match(html, /data-issue-detail="magnet"/);
  assert.match(html, /data-issue-subject=""[^]*lucide-wrench[^]*create_task/, "the tool as a pin");
  assert.match(html, /Narrow create_task&#x27;s description to making new tasks/);
  assert.match(
    html,
    new RegExp(
      `<a (?=[^>]*href="${ROOT}/quality/descriptions\\?tool=create_task")(?=[^>]*data-issue-fix="craft:fx-1")(?=[^>]*data-issue-fix-kind="description")[^>]*>[^]*?Update description`,
    ),
    "a description update opens Quality › Descriptions",
  );
  const other = detail("sig-chain-find-assign");
  assert.match(
    other,
    new RegExp(
      `<a (?=[^>]*href="${ROOT}/improvement/fixes\\?peek=craft%3Afx-2")(?=[^>]*data-issue-fix-kind="fix")[^>]*>Open fix`,
    ),
  );
  assert.match(html, /<h3[^>]*>Why it matters<\/h3>[^]*rides into 41% of lists/);
  assert.match(
    html,
    new RegExp(`href="${ROOT}/catalogs/tools\\?q=create_task&amp;highlight=create_task"`),
    "the tool it names opens on Catalog",
  );
  assert.match(
    html,
    /<h3[^>]*>Example turns<\/h3>[^]*data-issue-examples="loading"/,
    "read when opened, never with the page",
  );
  assert.ok(!visibleText(html).includes(CAPTURED));
  assert.match(html, />Details</);
  assert.match(
    detail("sig-padding-project", { fixes: null }),
    /No fix drafted for this yet\./,
    "without a fix it says so",
  );
});

test("an issue of several tools can be narrowed to one; a slow tool can be hidden as slow by design", () => {
  const rows = issueRows({
    projectId: PROJECT,
    signals: [
      {
        ...READY_MODEL.signals.find((s) => s.kind === "latency_outlier")!,
        id: "slow-1",
        severity: 0.5,
      },
      {
        ...READY_MODEL.signals.find((s) => s.kind === "latency_outlier")!,
        id: "slow-2",
        severity: 0.4,
        subject: {
          kind: "tool",
          key: "other_tool",
          label: "other_tool",
          chips: [{ id: "other_tool", label: "other_tool", entryKind: "tool" }],
        },
      },
    ],
    tooEarly: [],
    tasks: [],
    fixes: [],
  });
  const all = render(
    createElement(IssueDetail, {
      projectId: PROJECT,
      row: rows[0]!,
      initialMemberId: "slow-1",
      examplesAllowed: true,
      upgradeHref: null,
      focusExamples: false,
      cache: new Map(),
    }),
  );
  assert.match(
    all,
    /aria-pressed="true"[^>]*><span[^>]*>All 2 tools/,
    "the worst member opens on every tool",
  );
  assert.match(
    all,
    /aria-pressed="false"[^>]*>(?:(?!<\/button>)[^])*lucide-wrench(?:(?!<\/button>)[^])*other_tool/,
    "each member's tools as pins",
  );
  assert.match(visibleText(all), /The worst of 2 tools\. Pick one above for its own\./);
  const one = render(
    createElement(IssueDetail, {
      projectId: PROJECT,
      row: rows[0]!,
      initialMemberId: "slow-2",
      examplesAllowed: true,
      upgradeHref: null,
      focusExamples: false,
      cache: new Map(),
    }),
  );
  assert.match(
    one,
    /aria-pressed="true"[^>]*>(?:(?!<\/button>)[^])*other_tool/,
    "a link to one member opens on it",
  );
  assert.match(one, /data-slow-by-design="slow-2"[^]*Hide: slow by design/);
});

test("a plan without example turns says how many there are and where to get them", () => {
  const html = detail("sig-magnet-create-task", { examplesAllowed: false });
  // Owned: no plan to pick, so the lock names the limits and offers no link.
  assert.match(html, /data-issue-examples="locked"/);
  assert.doesNotMatch(html, /See plans/);
  assert.match(
    visibleText(html),
    /509 turns stand behind this issue\. Example turns are outside this project(?:'|&#x27;)s limits\./,
  );
  const page = render(
    createElement(
      SummaryView,
      props({ model: { ...READY_MODEL, evidenceTurnsPerSignal: 0, lockedCount: 3 } }),
    ),
    { pathname: `${ROOT}/health` },
  );
  assert.match(page, /data-signals-locked="3"/);
  assert.match(visibleText(page), /3 more issues outside this project(?:'|&#x27;)s limits\./);
  assert.doesNotMatch(page, /See plans/);
});

function otelTile(
  key: HealthTile["key"],
  value: number,
  unit: HealthTile["unit"],
  upIsGood: boolean,
  sub: string,
): HealthTile {
  return {
    key,
    label: key,
    value,
    unit,
    interval: null,
    sub,
    tier: "deterministic",
    upIsGood,
    delta: 0.01,
    series: [],
    n: 298,
  };
}

test("OpenTelemetry only: its readings, its shapes and the source in the line under the title", () => {
  const otel: HealthPageModel = {
    ...READY_MODEL,
    sourceMode: "otel",
    tiles: [
      otelTile("completed", 0.97, "share", true, "288 of 298 runs ended without a failed call."),
      otelTile("failed_calls", 0.07, "share", false, "34 of 508 tool calls failed."),
      otelTile(
        "wasted_calls",
        5.7,
        "per_100_turns",
        false,
        "17 repeats and retries of the same tool.",
      ),
      otelTile("round_trips", 2.7, "per_turn", false, "806 model calls over 298 runs."),
    ],
    shapes: [
      {
        shape: "otel_direct",
        label: "Direct",
        description: "One tool call, and it worked.",
        share: 0.6,
        count: 180,
      },
      {
        shape: "otel_retry",
        label: "Retry",
        description: "A tool failed, and the agent ran it again.",
        share: 0.4,
        count: 118,
      },
    ],
  };
  const html = page({ model: otel });
  assertHouseStyle(html, "otel");
  assert.match(visibleText(html), /through OpenTelemetry\./);
  assert.match(html, /data-call-order-source="otel"/, "the call order says its lane");
  for (const label of ["Finish rate", "Failed calls", "Model calls per run"])
    assert.match(html, new RegExp(`>${label}<`));
  assert.match(html, /data-shape-pictogram="otel_retry"/);
  assert.match(html, /aria-label="Key"[^]*Another tool/);
});

test("runs mixed together: the run-based sections give way to one block that says how to send turn ids", () => {
  const mixed: HealthPageModel = {
    ...READY_MODEL,
    workflows: { ...WORKFLOWS, blocked: "mixed_runs" },
    setup: { ...SETUP, warnings: ["mixed_runs"] },
  };
  const html = page({ model: mixed, corrections: { ...CARD, state: "mixed_runs" } });
  assertHouseStyle(html, "mixed runs");
  assert.match(
    html,
    /data-health-gap="mixed_runs"[^]*Runs are mixed together[^]*href="[^"]*\?peek=setup%3Asdk_turn_ids"[^>]*>How to send turn ids/,
  );
  assert.doesNotMatch(html, />Turn shapes</);
  assert.doesNotMatch(html, /data-tool-flow-map/);
  assert.match(html, /data-setup-alert=""/, "the callout says why");
  assert.match(html, /Needs turn ids/, "self-corrections say what they need");
  assert.match(
    html,
    /<dt[^>]*>(?:<a[^>]*>)?First try(?:<\/a>)?<\/dt><dd[^>]*><span[^>]*>–<\/span>/,
    "readings that need whole runs show a dash",
  );
});

test("a newer reading on its way: the page watches for it", () => {
  assert.match(page({ state: { kind: "ready", updating: true } }), /data-health-watching=""/);
});

test("reads that failed cost their part, not the page", () => {
  const html = page({
    tasks: null,
    fixes: null,
    corrections: { ...CARD, state: "unavailable" },
  });
  assertHouseStyle(html, "degraded");
  assert.match(html, /role="alert"[^]*Couldn&#x27;t load tasks/);
  assert.doesNotMatch(html, /data-issue-action="fix"/, "without Fixes no issue claims a fix");
  assert.match(html, /Couldn&#x27;t load self-corrections/);
  assert.match(html, /aria-label="Download"/, "the PDF stays");
});

const STATES: readonly [string, HealthPageState, RegExp][] = [
  ["nothing yet", { kind: "nothing_yet" }, /No runs yet[^]*Get an API key/],
  [
    "collecting",
    { kind: "too_few", turns: 14, floor: 50, imported: false, wider: { days: 30, plan: null } },
    /role="meter"[^]*14 turns in the last 7\sdays/,
  ],
  [
    "being built",
    {
      kind: "building",
      phase: "computing",
      turns: 60,
      imported: true,
      source: "langfuse",
      working: true,
    },
    /data-health-building="computing"[^]*Building your reading from 60 imported runs/,
  ],
  [
    "outside the window",
    {
      kind: "outside_window",
      turns: 60,
      imported: false,
      firstDay: "2026-10-01",
      lastDay: "2026-10-09",
      suggestion: { days: 30, plan: null },
    },
    /No runs in the last 7\sdays[^]*Show 30\sdays/,
  ],
  [
    "imported runs with no tools",
    { kind: "imported_no_tools", runs: 12, source: "langfuse" },
    /Your imported runs have no tool calls/,
  ],
  ["a read that failed", { kind: "unavailable" }, /role="alert"[^]*The reading did not load/],
];

for (const [name, state, expected] of STATES) {
  test(`before a reading, ${name}: one block where the reading would be`, () => {
    const model =
      state.kind === "too_few"
        ? { ...pendingHealthModel(7), turns: 14 }
        : state.kind === "nothing_yet"
          ? MOCK_NO_TELEMETRY
          : pendingHealthModel(7);
    const html = page({ model, state });
    assertHouseStyle(html, name);
    assert.match(html, expected);
    assert.match(html, new RegExp(`data-health-page-state="${state.kind}"`));
    assert.doesNotMatch(html, /data-health-issues=/, "no issues before a reading");
    assert.doesNotMatch(html, /aria-label="Download"/, "the report waits for a reading");
    if (state.kind === "too_few" || state.kind === "building")
      assert.match(html, /data-health-readings="4"/, "the readings wait as dashes while it fills");
    else assert.doesNotMatch(html, /data-health-readings=/);
  });
}

test("model calls arrive with no tool spans: what to send, with the guide in place", () => {
  const html = page({
    model: { ...pendingHealthModel(7), waitingOn: "tool_spans" },
    state: { kind: "tool_spans" },
  });
  assertHouseStyle(html, "tool spans");
  assert.match(
    html,
    /data-health-state="tool_spans_missing"[^]*Model calls arrive, but no tool calls/,
  );
  assert.match(html, /data-setup-guide="otel_tool_spans"/);
});

test("without a decided state, the model's own count decides: the collecting meter", () => {
  const html = page({ model: { ...pendingHealthModel(7), turns: 14 }, state: null });
  assert.match(html, /data-health-page-state="too_few"/);
  assert.match(html, /role="meter"/);
});

test("the loading state and the page without a database keep the header", () => {
  const skeleton = render(createElement(SummarySkeleton));
  assertHouseStyle(skeleton, "skeleton");
  assert.match(skeleton, /role="status"[^>]*>Loading Agent health…/);
  assert.match(skeleton, /data-summary-skeleton=""/);
  const noDb = render(createElement(SummaryNoDatabase));
  assert.match(noDb, /<h1[^>]*>Agent health<\/h1>[^]*No database connected yet/);
});
