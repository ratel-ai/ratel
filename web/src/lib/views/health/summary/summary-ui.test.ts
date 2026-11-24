// First: lets node load the components' stylesheet imports, and gives the router contexts.

import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { createElement } from "react";
import { FocusedHealthView } from "@/components/console/health/focused/FocusedHealthView";
import { setupPill } from "@/components/console/health/setup-card-model";
import { IssueDetail } from "@/components/console/health/v2/IssueDetail";
import { Guide } from "@/components/console/health/v2/SetupGuidePanel";
import { SummarySkeleton } from "@/components/console/health/v2/SummarySkeleton";
import {
  SummaryNoDatabase,
  type SummaryViewProps,
} from "@/components/console/health/v2/SummaryView";
import { fixLookups } from "@/components/console/health/v2/summary-model";
import { composition } from "@/lib/composition/ports";
import type { ImportSummary } from "@/lib/contracts/imported-runs";
import { healthScoreView } from "@/lib/readings/trace-signals/health-score";
import type { StoredSetup } from "@/lib/readings/trace-signals/setup-facts";
import {
  type HealthPageModel,
  type WorkflowsView,
  windowOptionsForPlan,
} from "@/lib/readings/trace-signals/view";
import type { Fix } from "@/lib/views/fixes/types";
import { issueRows, rowOfIssue } from "@/lib/views/health/issue-rows";
import { MOCK_HEALTH_MODEL, MOCK_NO_TELEMETRY } from "@/lib/views/health/mock-fixture";
import { pendingHealthModel } from "@/lib/views/health/page-model";
import type { HealthPageState } from "@/lib/views/health/page-state";
import { OTEL_UNLOCKS } from "@/lib/views/health/signals/otel-metrics";
import type { TaskListModel, TaskRow } from "@/lib/views/tasks/model";
import { attributeValues, render, visibleText } from "@/lib/views/tasks/test-support";
import { findDsViolations } from "../../../../../eslint-rules/ds-tokens.mjs";

/**
 * Agent health as a reader sees it, in every state: the reading,
 * before one (nothing yet, collecting, being built, outside the window, no
 * tool calls, a read that failed), runs mixed together, and OpenTelemetry
 * or SDK runs. Each checks the house rules (DESIGN.md), the product's nouns
 * (never "topic"), and that what users wrote never sits in an attribute.
 *
 * Owned (ADR-0004): no importer, share link or plan link on the Summary.
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

const SETUP: StoredSetup = {
  version: 1,
  lanes: { sdk: true, otel: false },
  facts: [
    { key: "sdk_tool_calls", status: "on", share: 1 },
    { key: "sdk_turn_ids", status: "off", share: 0 },
    { key: "sdk_user_messages", status: "partial", share: 0.42 },
  ],
};

const READY_MODEL: HealthPageModel = {
  ...MOCK_HEALTH_MODEL,
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
    billingHref: null,
    tasks: TASKS,
    fixes: { open: [FIX, REWRITE, COMBINE], applied: [] },
    reportHref: `/report/health/${PROJECT}?days=7&print=1`,
    imports: null,
    ...over,
  };
}

function anImport(over: Partial<ImportSummary> = {}): ImportSummary {
  return {
    id: "imp-1",
    source: "langfuse",
    status: "completed",
    label: "cloud.langfuse.com",
    windowDays: 7,
    itemsRead: 180,
    runsImported: 60,
    truncated: false,
    failure: null,
    failureDetail: null,
    startedAt: "2026-10-20T11:24:39.188Z",
    finishedAt: "2026-10-20T11:24:51.416Z",
    relay: false,
    ...over,
  };
}

/** An edition's importer, as the page receives it; the Importer itself renders nothing here. */
function importsOf(list: ImportSummary[]): NonNullable<SummaryViewProps["imports"]> {
  return { list, contactUrl: null, sourceLabel: {}, Importer: () => null };
}

function page(over: Partial<SummaryViewProps> = {}, search = ""): string {
  return render(createElement(FocusedHealthView, props(over)), {
    pathname: `${ROOT}/health`,
    search,
  });
}

/** Sections Agent health no longer shows: no state's copy may name them. */
const REMOVED_SECTIONS =
  /asks below|numbers below|[Tt]urn shapes|[Rr]un shapes|tool map|[Cc]all order|What each tool needs first/;

/** DESIGN.md's rules and the product's nouns, on every render. */
function assertHouseStyle(html: string, where: string) {
  const text = visibleText(html);
  assert.doesNotMatch(text, REMOVED_SECTIONS, `${where}: no removed section`);
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

/** The detail a row's Panel holds (a Panel renders in a portal, so the detail is rendered on its own here). */
function detail(
  signalId: string,
  over: {
    examplesAllowed?: boolean;
    fixes?: SummaryViewProps["fixes"];
    lockedPlan?: string | null;
  } = {},
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
      lockedPlan: over.lockedPlan ?? null,
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
      FocusedHealthView,
      props({ model: { ...READY_MODEL, evidenceTurnsPerSignal: 0, lockedCount: 3 } }),
    ),
    { pathname: `${ROOT}/health` },
  );
  assert.match(page, /data-signals-locked="3"/);
  assert.match(visibleText(page), /3 more issues outside this project(?:'|&#x27;)s limits\./);
  assert.doesNotMatch(page, /See plans/);
});

test("with an edition's plans, the locks name the plan that shows them, as upstream's do", () => {
  const html = detail("sig-magnet-create-task", { examplesAllowed: false, lockedPlan: "Plus" });
  assert.match(
    visibleText(html),
    /509 turns stand behind this issue\. Example turns are on Plus\./,
  );
  const page = render(
    createElement(
      FocusedHealthView,
      props({
        model: { ...READY_MODEL, evidenceTurnsPerSignal: 0, lockedCount: 3 },
        lockedPlan: "Plus",
      }),
    ),
    { pathname: `${ROOT}/health` },
  );
  assert.match(visibleText(page), /3 more issues on Plus\./);
});

/** An edition's plan table, as upstream's (Hobby 7 days, Plus 30, Pro 90), for one test. */
function withPlans(t: TestContext): void {
  const previous = composition.entitlements;
  composition.entitlements = {
    ...previous,
    plans: {
      summary: () => {
        throw new Error("not read by the Summary");
      },
      withAgentHealthWindow: (days) => (days <= 7 ? "free" : days <= 30 ? "plus" : "pro"),
      name: (planId) => ({ free: "Hobby", plus: "Plus", pro: "Pro" })[planId] ?? planId,
    },
  };
  t.after(() => {
    composition.entitlements = previous;
  });
}

test("with self-serve billing: the plan a window needs is named, and See plans links to Billing", (t) => {
  withPlans(t);
  const billingHref = "/org/acme/billing";
  const ready = render(createElement(FocusedHealthView, props({ billingHref })), {
    pathname: `${ROOT}/health`,
  });
  // The window as links, the plan's longest one locked with the plan that has it.
  assert.match(ready, /data-health-window-locked="90"[^]*90 days[^]*, on Pro/);

  const locked = render(
    createElement(
      FocusedHealthView,
      props({
        billingHref,
        model: { ...READY_MODEL, evidenceTurnsPerSignal: 0, lockedCount: 3 },
      }),
    ),
    { pathname: `${ROOT}/health` },
  );
  assert.match(locked, /data-signals-locked="3"[^]*href="\/org\/acme\/billing"[^>]*>See plans/);

  const tooFew = render(
    createElement(
      FocusedHealthView,
      props({
        billingHref,
        state: {
          kind: "too_few",
          turns: 12,
          floor: 50,
          imported: false,
          wider: { days: 30, plan: "plus" },
        },
      }),
    ),
    { pathname: `${ROOT}/health` },
  );
  assert.match(visibleText(tooFew), /The last 30 days have enough, and Plus includes them\./);
  assert.match(tooFew, /data-health-see-plans="true"[^>]*>See plans/);
  assert.match(tooFew, /href="\/org\/acme\/billing"/);
  assert.doesNotMatch(tooFew, /data-health-window-switch=/, "no link to a window the plan lacks");

  // Billing off: no plan is named and nothing links to Billing.
  const off = render(
    createElement(
      FocusedHealthView,
      props({
        billingHref: null,
        state: {
          kind: "too_few",
          turns: 12,
          floor: 50,
          imported: false,
          wider: { days: 30, plan: "plus" },
        },
      }),
    ),
    { pathname: `${ROOT}/health` },
  );
  assert.doesNotMatch(off, /See plans|Plus includes/);
});

test("runs mixed together: the run-based sections give way to one block that says how to send turn ids", () => {
  const mixed: HealthPageModel = {
    ...READY_MODEL,
    workflows: { ...WORKFLOWS, blocked: "mixed_runs" },
    setup: { ...SETUP, warnings: ["mixed_runs"] },
  };
  const html = page({ model: mixed });
  assertHouseStyle(html, "mixed runs");
  assert.match(
    html,
    /data-health-gap="mixed_runs"[^]*Runs are mixed together[^]*href="[^"]*\?peek=setup%3Asdk_turn_ids"[^>]*>How to send turn ids/,
  );
  assert.doesNotMatch(html, />Turn shapes</);
  assert.doesNotMatch(html, /data-tool-flow-map/);
  assert.match(html, /data-setup-alert=""/, "the callout says why");
});

test("a newer reading on its way: the page watches for it", () => {
  assert.match(page({ state: { kind: "ready", updating: true } }), /data-health-watching=""/);
});

test("an early reading says it is a first look, still being processed, and that more will come (RC-224)", () => {
  const early = page({
    model: { ...READY_MODEL, earlyReading: true, signalWindowDays: 7 },
    state: { kind: "ready", updating: true },
  });
  assertHouseStyle(early, "early reading");
  assert.match(early, /data-health-early-reading="updating"/);
  const text = visibleText(early);
  assert.match(text, /Early reading: we are still processing/);
  assert.match(text, /your most recent runs \(the last 7 days\)/);
  assert.match(text, /will fill in and may change/);
  assert.match(early, /data-health-watching=""/, "and the page watches for the full reading");
  assert.ok(
    text.indexOf("Early reading") < text.indexOf("Issues"),
    "the note sits above the reading",
  );

  const importing = page({
    model: { ...READY_MODEL, earlyReading: true },
    imports: importsOf([anImport({ status: "running" })]),
  });
  assert.match(importing, /data-health-early-reading="waiting"/);
  assert.match(visibleText(importing), /the rest of your import as it comes in/);

  // A full reading carries no note.
  assert.doesNotMatch(page(), /data-health-early-reading/);
});

test("a reading that read none of the imported runs shows no score and no verdict, only the building state (RC-255)", () => {
  const score = healthScoreView([], 0);
  const model = {
    ...READY_MODEL,
    signals: [],
    score,
    earlyReading: true as const,
    earlyProgress: { read: 0, total: 73, percent: 1 },
    emptyEarlyReading: true as const,
  };
  const html = page({
    model,
    state: {
      kind: "building",
      phase: "computing",
      turns: 73,
      imported: true,
      source: null,
      working: true,
    },
  });
  assertHouseStyle(html, "empty early reading");
  const text = visibleText(html);
  assert.match(text, /Building your reading from 73/);
  assert.doesNotMatch(html, /data-health-score=/);
  assert.doesNotMatch(text, /great shape|Healthy|of 100/);
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
  });
}

test("an edition's importer: offered by the state and the menu, mounted once, its source names in the copy", () => {
  const Importer = ({ variant }: { variant: string }) =>
    createElement("div", { "data-stub-importer": variant });
  const imports = { list: [], contactUrl: null, sourceLabel: { langsmith: "LangSmith" }, Importer };
  const empty = page({ model: MOCK_NO_TELEMETRY, state: { kind: "nothing_yet" }, imports });
  assert.match(empty, /No runs yet[^]*Import past runs[^]*Get an API key/);
  assert.match(empty, /data-stub-importer="history"/);
  const named = page({
    model: pendingHealthModel(7),
    state: { kind: "imported_no_tools", runs: 12, source: "langsmith" },
    imports,
  });
  assert.match(named, /imported from LangSmith/);
  const ready = page({ imports });
  assert.match(ready, /aria-label="Import and download"/);
  assert.match(ready, /data-stub-importer="dialog"/);
  assert.doesNotMatch(
    page(),
    /Import past runs|data-stub-importer/,
    "no importer without an edition",
  );
});

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

test("tool calls inferred from imported span shape: one callout near the top says so", () => {
  const noAsks: HealthPageModel = {
    ...READY_MODEL,
    sourceMode: "otel",
    workflows: { ...WORKFLOWS, unserved: [] },
  };
  const html = page({ model: noAsks, inferredTools: true });
  assertHouseStyle(html, "inferred tools");
  const text = visibleText(html);
  assert.match(text, /Tool calls inferred from span shape · content not captured/);
  assert.equal((html.match(/data-health-inferred-tools=""/g) ?? []).length, 1, "one callout");
  assert.match(
    html,
    /href="https:\/\/www\.ratel\.sh\/docs\/cloud\/import-tool-calls"/,
    "it links the guide",
  );
  assert.ok(
    html.indexOf("<h2") > 0 && html.indexOf("data-health-inferred-tools") < html.indexOf("<h2"),
    "above every section",
  );

  assert.match(text, /so issues that need them are not found/);
  assert.doesNotMatch(text, REMOVED_SECTIONS);

  const off = page({ model: noAsks });
  assert.doesNotMatch(off, /data-health-inferred-tools/, "recorded tool calls: no callout");
});

test("a failed Fixes read costs only the fixes", () => {
  const html = page({ tasks: null, fixes: null });
  assertHouseStyle(html, "degraded");
  assert.doesNotMatch(html, /data-issue-action="fix"/, "without Fixes no issue claims a fix");
  assert.match(html, /aria-label="Download"/, "the PDF stays");
});

test("no setup or first-look state names a section the page does not show", () => {
  const otel = {
    ...READY_MODEL,
    setup: null,
    sourceMode: "otel" as const,
    captureUnlocks: Object.values(OTEL_UNLOCKS),
  };
  const nudge = visibleText(page({ model: otel }));
  assert.match(nudge, /Adds: /);
  assert.doesNotMatch(nudge, REMOVED_SECTIONS);
  assertHouseStyle(
    page({ model: { ...READY_MODEL, lowConfidence: { turns: 24, firmsUpAt: 50 } } }),
    "low confidence",
  );
  for (const key of ["otel_conversation_id", "sdk_tool_calls"] as const) {
    const guide = render(
      createElement(Guide, { pill: setupPill({ key, status: "off", share: 0 }) }),
    );
    assert.doesNotMatch(visibleText(guide), REMOVED_SECTIONS, key);
  }
});
