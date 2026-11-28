// First: lets node load the components' stylesheet imports, and gives the router contexts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { PathParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { createElement } from "react";
import { FocusedHealthView } from "@/components/console/health/focused/FocusedHealthView";
import { DashboardWidgetList } from "@/components/console/home/focused/DashboardWidgetPicker";
import { FocusedOverviewView } from "@/components/console/home/focused/FocusedOverviewView";
import { HistoryBody } from "@/components/console/home/focused/HistoryDialog";
import type { LayoutActions } from "@/components/console/home/focused/OverviewLayout";
import { offeredTo } from "@/components/console/home/focused/widgets";
import { OverviewSkeleton } from "@/components/console/home/OverviewSkeleton";
import { SelfCorrectionsSkeleton } from "@/components/console/self-corrections/SelfCorrectionsSkeleton";
import { FocusedConsoleProvider } from "@/components/console/shell/focused-console-context";
import { TOUR_STEPS, tourSteps } from "@/lib/console/onboarding/tour-steps";
import { metricQuery } from "@/lib/contracts/query";
import {
  HEALTH_SCORE_VERSION,
  healthScoreView,
  scoredIssues,
} from "@/lib/readings/trace-signals/health-score";
import { type HealthPageModel, windowOptionsForPlan } from "@/lib/readings/trace-signals/view";
import { formOf, formWidget } from "@/lib/views/dashboards/widget";
import { MOCK_HEALTH_MODEL } from "@/lib/views/health/mock-fixture";
import { pendingHealthModel } from "@/lib/views/health/page-model";
import type { DashboardItem } from "@/lib/views/home/dashboard-items";
import {
  type FocusedOverviewData,
  type FocusedReads,
  healthCard,
  loadFocusedOverview,
} from "@/lib/views/home/focused-load";
import type { LayoutHistoryEntry } from "@/lib/views/overview-layout/actions";
import {
  changeLayout,
  DEFAULT_LAYOUT,
  dashboardItemId,
  OVERVIEW_WIDGETS,
  type OverviewLayout,
  type OverviewWidgetId,
} from "@/lib/views/overview-layout/domain/layout";
import { topologyModel } from "@/lib/views/project-entities/topology";
import { PROJECT_ID, render, visibleText } from "@/lib/views/tasks/test-support";
import { findDsViolations } from "../../../../eslint-rules/ds-tokens.mjs";

/** The recap Overview (`focusedConsole`): what it reads, and every state it draws. */

const NOW = new Date("2026-11-24T12:00:00.000Z");
const AT = new Date("2026-11-24T11:00:00.000Z");
const ORGANIZATION = { id: "o1" } as Parameters<typeof loadFocusedOverview>[0]["organization"];
const PROJECT = { id: PROJECT_ID, name: "Support bot", slug: "support-bot", isDemo: false };
const LIMITS = {
  agentHealthSignalsShown: Number.POSITIVE_INFINITY,
  agentHealthEvidenceTurns: 3,
  agentHealthWindowDays: 90,
};
const SCORE = healthScoreView(
  scoredIssues(
    MOCK_HEALTH_MODEL.signals.map((signal) => ({
      id: signal.id,
      kind: signal.kind,
      severity: signal.severity,
      totalTurns: signal.evidence.totalTurns,
    })),
  ),
  MOCK_HEALTH_MODEL.turns,
  [{ version: HEALTH_SCORE_VERSION, value: 40 }],
  [],
);
const MODEL: HealthPageModel = { ...MOCK_HEALTH_MODEL, score: SCORE };
const GRAPH = topologyModel({
  agents: [{ key: "main", displayName: "main", calls: 3, errorRate: 0 }],
  handoffs: [],
  servers: [],
  calls: [],
  hidden: new Set(),
  names: new Map(),
});

const AGGREGATE = {
  count: 0,
  errorCount: 0,
  errorRate: 0,
  p50DurationMs: null,
  p95DurationMs: null,
  p99DurationMs: null,
  costUsd: 0,
  totalTokens: 0,
  volume: [],
};

function reads(over: Partial<FocusedReads> = {}) {
  const ran: string[] = [];
  const base: FocusedReads = {
    telemetry: async () => ({
      hasEvents: false,
      hasSpans: true,
      latestEventAt: null,
      latestSpanAt: AT,
    }),
    sdkLatestAt: async () => null,
    health: async () => MODEL,
    topology: async () => GRAPH,
    traces: async () => AGGREGATE,
    previous: async () => AGGREGATE,
    dailyTraces: async () => [],
    sdkDays: async () => [],
    sdkPrevious: async () => ({ searches: 0, toolCalls: 0, skillRuns: 0 }),
    fixes: async () => ({ open: [], applied: [], rewritesOn: false }),
    pendingRewrites: async () => 0,
    intents: async () => null,
    tasks: async () => null,
    dailyAggregates: async () => [],
    alerting: async () => [],
    alertRules: async () => ({ total: 0, on: 0, noData: 0 }),
    dashboards: async () => ({}),
    context: async () => ({ split: null, suggestions: [], promptCacheHitRate: null }),
    ...over,
  };
  const logged = Object.fromEntries(
    Object.entries(base).map(([name, read]) => [
      name,
      (...args: unknown[]) => {
        ran.push(name);
        return (read as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  ) as unknown as FocusedReads;
  return { reads: logged, ran };
}

const load = (
  over: Partial<FocusedReads> = {},
  rest: Partial<Parameters<typeof loadFocusedOverview>[0]> = {},
) =>
  loadFocusedOverview({
    project: PROJECT,
    organization: ORGANIZATION,
    window: 7,
    now: NOW,
    reads: reads(over).reads,
    limits: LIMITS,
    ...rest,
  });

const fail = async () => {
  throw new Error("statement timeout");
};
const NO_SPANS = async () => ({
  hasEvents: false,
  hasSpans: false,
  latestEventAt: null,
  latestSpanAt: null,
});

const SNAPSHOT = { layout: DEFAULT_LAYOUT, revision: "0.0", undo: null };
const SAVED = async () => ({ ok: true as const, changed: null, ...SNAPSHOT });
const ACTIONS: LayoutActions = {
  save: SAVED,
  undo: SAVED,
  restore: SAVED,
  history: async () => ({ ok: true, entries: [], snapshot: SNAPSHOT }),
  dashboardWidgets: async () => ({ ok: true, dashboards: [] }),
};

function page(
  data: FocusedOverviewData,
  {
    linked = true,
    save = ACTIONS,
    undo = null,
    edit = false,
  }: { linked?: boolean; save?: LayoutActions | null; undo?: string | null; edit?: boolean } = {},
): string {
  const html = render(
    createElement(FocusedOverviewView, {
      data,
      now: NOW,
      linked,
      saved: { revision: "0.0", undo },
      layoutActions: save,
      startEditing: edit,
      setup: "SETUP GUIDE",
    }),
    { pathname: `/project/${PROJECT_ID}` },
  );
  const violations = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => findDsViolations(m[1]));
  assert.deepEqual([...new Set(violations)], [], "semantic tokens only");
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1, "one h1");
  assert.doesNotMatch(visibleText(html), /—/, "no em dash");
  return html;
}

test("reads the context only for its Panel", async () => {
  const closed = reads();
  await load({}, { reads: closed.reads });
  assert.ok(!closed.ran.includes("context"));
  const open = reads();
  await load({}, { reads: open.reads, contextOpen: true });
  assert.deepEqual(open.ran.sort(), [...closed.ran, "context"].sort());
});

const order = (html: string) => [...html.matchAll(/data-card="(\w+)"/g)].map((match) => match[1]);
const removed = (...ids: OverviewWidgetId[]) =>
  ids.reduce<OverviewLayout>(
    (layout, widget) => changeLayout(layout, { kind: "remove", widget }),
    DEFAULT_LAYOUT,
  );

test("without a stored layout: Metrics, Topology, then Health with Needs attention beside it, then Alerts", async () => {
  const html = page(await load());
  assert.deepEqual(order(html), ["metrics", "topology", "health", "attention", "alerts"]);
  const headings = [...html.matchAll(/<h2[^>]*>([^<]+)</g)].map((match) => match[1]);
  assert.deepEqual(headings, [
    "Metrics",
    "Agents and MCP servers",
    "Health score",
    "Needs attention",
    "Alerts",
  ]);
  const places = [...html.matchAll(/--cell-column:([^;"]+);--cell-row:([^;"]+)/g)];
  assert.equal(places.length, 5, "the server draws the places");
  assert.equal(places[2][2], places[3][2], "Health and Needs attention share their rows");
  const text = visibleText(html);
  assert.match(text, /Receiving data/);
  assert.match(text, /Runs .*Failed runs .*Median duration .*Spend/);
  for (const dropped of ["Recent runs", "Intents", "Self-corrections"])
    assert.ok(!text.includes(dropped), `no "${dropped}"`);
});

test("the page is the person's layout: their order, and no removed widget", async () => {
  const moved = changeLayout(removed("topology"), {
    kind: "move",
    widget: "attention",
    x: 4,
    y: 0,
  });
  assert.deepEqual(order(page(await load({}, { layout: moved }))), [
    "attention",
    "metrics",
    "health",
    "alerts",
  ]);
  for (const id of OVERVIEW_WIDGETS) {
    const others = OVERVIEW_WIDGETS.filter((other) => other !== id);
    assert.deepEqual(order(page(await load({}, { layout: removed(...others) }))), [id], "alone");
  }
});

test("no widgets is one line, with Edit, or with Add widget in edit mode", async () => {
  const data = await load({}, { layout: removed(...OVERVIEW_WIDGETS) });
  const line = /data-overview-empty=""[^>]*>The Overview has no widgets\.<button.*?<\/p>/;
  const view = page(data);
  assert.deepEqual(order(view), []);
  assert.match(visibleText(view.match(line)?.[0] ?? ""), /Edit/);
  assert.match(visibleText(page(data, { edit: true }).match(line)?.[0] ?? ""), /Add widget/);
  assert.doesNotMatch(page(data, { save: null }), /<button[^>]*overview-edit/);
});

const CONTROLS = /data-grid-handle|data-grid-surface|role="toolbar"|aria-label="(Arrange|Remove) /;

test("view mode is quiet: no visible title, border or control on a widget", async () => {
  const html = page(await load());
  assert.doesNotMatch(html, CONTROLS);
  assert.doesNotMatch(html, /Customize|data-edit-bar/);
  for (const section of html.matchAll(/<section[^>]*data-card[^>]*>/g))
    assert.match(section[0], /border-transparent/);
  for (const heading of html.matchAll(/<h2[^>]*>/g)) assert.match(heading[0], /sr-only/);
  assert.match(visibleText(html), /Edit/);
});

test("edit mode: a toolbar per widget, and a body that takes no press", async () => {
  const data = await load();
  const html = page(data, { edit: true });
  for (const title of [
    "Metrics",
    "Agents and MCP servers",
    "Health score",
    "Needs attention",
    "Alerts",
  ]) {
    assert.match(html, new RegExp(`role="toolbar" aria-label="${title}"`));
    assert.match(html, new RegExp(`aria-label="Arrange ${title}"`));
    assert.match(html, new RegExp(`aria-label="Remove ${title}"`));
  }
  assert.equal((html.match(/data-grid-body="" inert=""/g) ?? []).length, 5);
  for (const words of ["Add widget", "Reset", "Done"])
    assert.match(visibleText(html), new RegExp(words));
  assert.deepEqual(order(html), order(page(data)));
});

test("Undo and History are in edit mode only, and Undo says what it takes back", async () => {
  const data = await load();
  const buttons = (html: string) =>
    [...html.matchAll(/<button[^>]*aria-label="((?:Undo|History)[^"]*)"[^>]*>/g)].map(
      ([tag, label]) => [label, /aria-disabled="true"/.test(tag)],
    );
  for (const undo of [null, "Removed Metrics"]) {
    assert.deepEqual(buttons(page(data, { undo })), []);
    assert.deepEqual(buttons(page(data, { undo, save: null, edit: true })), []);
  }
  assert.deepEqual(buttons(page(data, { edit: true })), [
    ["Undo", true],
    ["History", false],
  ]);
  assert.deepEqual(buttons(page(data, { edit: true, undo: "Removed Metrics" })), [
    ["Undo: Removed Metrics", false],
    ["History", false],
  ]);
});

const ENTRY: LayoutHistoryEntry = {
  id: 2,
  kind: "change",
  personId: "user_1",
  source: { kind: "mcp", client: "claude-code" },
  at: new Date(NOW.getTime() - 5 * 60_000),
  summary: "Removed Metrics",
  layout: DEFAULT_LAYOUT,
  readable: true,
  current: false,
};

function historyHtml(over: Partial<Parameters<typeof HistoryBody>[0]> = {}): string {
  return render(
    createElement(HistoryBody, {
      history: {
        ok: true,
        snapshot: SNAPSHOT,
        entries: [
          { ...ENTRY, id: 3, source: { kind: "web" }, summary: "Resized Metrics", current: true },
          ENTRY,
          { ...ENTRY, id: 1, summary: "Moved Metrics", layout: null, readable: false },
        ],
      },
      notice: null,
      restoring: null,
      now: NOW,
      onRestore: () => undefined,
      onRetry: () => undefined,
      ...over,
    }),
  );
}

test("the history: who, where, when and what, and Restore where there is something to restore", () => {
  const html = historyHtml();
  const text = visibleText(html);
  assert.match(text, /Resized Metrics ?You on the web, ?5m ago ?Current layout/);
  assert.match(text, /Removed Metrics ?You through claude-code, ?5m ago ?Restore/);
  assert.match(text, /Moved Metrics.*Made by a newer version/);
  assert.equal((html.match(/aria-label="Restore the layout after: /g) ?? []).length, 1);
  assert.match(html, /<time dateTime="[^"]+" title="[^"]+ UTC"/);
});

test("the history: loading, empty, failed, stale and a failed restore each have their own state", () => {
  assert.match(historyHtml({ history: null }), /role="status"/);
  const empty = { ok: true as const, entries: [], snapshot: SNAPSHOT };
  assert.match(visibleText(historyHtml({ history: empty })), /No changes yet/);
  const failed = historyHtml({ history: { ok: false, message: "The server did not answer." } });
  assert.match(visibleText(failed), /The history did not load.*did not answer.*Try again/);
  assert.match(visibleText(historyHtml({ notice: { kind: "stale" } })), /changed in another place/);
  const refused = historyHtml({ notice: { kind: "failed", message: "Gone." } });
  assert.match(visibleText(refused), /The layout was not restored.*Gone\./);
});

test("a read-only viewer has no Edit, and never edit mode", async () => {
  const data = await load();
  for (const edit of [false, true]) {
    const html = page(data, { save: null, edit });
    assert.deepEqual(order(html), order(page(data)));
    assert.doesNotMatch(html, CONTROLS);
    assert.doesNotMatch(html, /overview-edit|overview-add-widget/);
  }
});

test("each widget leads somewhere", async () => {
  const html = page(await load());
  for (const path of ["traces\\?range=7d", "agents", "health"])
    assert.match(html, new RegExp(`href="/project/${PROJECT_ID}/${path}`));
  assert.match(visibleText(html), /See all agents/);
  assert.doesNotMatch(visibleText(page(await load(), { linked: false })), /See all agents/);
});

test("the Add widget dialog lists what the server offers", () => {
  assert.deepEqual(
    offeredTo(DEFAULT_LAYOUT).map(({ id }) => id),
    OVERVIEW_WIDGETS,
  );
  assert.deepEqual(
    offeredTo(DEFAULT_LAYOUT.filter(({ id }) => id !== "health")).map(({ id }) => id),
    ["metrics", "topology", "attention", "alerts"],
  );
});

test("the gauge shows Agent health's value and opens it in its window", async () => {
  const html = page(await load({}, { window: 30 }));
  assert.match(html, new RegExp(`href="/project/${PROJECT_ID}/health\\?days=30"`));
  const health = render(
    createElement(FocusedHealthView, {
      projectId: PROJECT_ID,
      projectName: "Support bot",
      model: MODEL,
      state: { kind: "ready" },
      windowOptions: windowOptionsForPlan(90),
      billingHref: null,
      tasks: null,
      fixes: null,
      reportHref: null,
      imports: null,
    }),
  );
  const value = (of: string) => of.match(/data-health-score="(\d+)"/)?.[1];
  assert.equal(value(html), String(SCORE.value));
  assert.equal(value(html), value(health));
  assert.doesNotMatch(html, /data-health-lost|since the last reading/, "the gauge only");
});

test("a plan that caps the health window says which window the score is for", async () => {
  const asked: number[] = [];
  const data = await load(
    {
      health: async (_project, windowDays) => {
        asked.push(windowDays);
        return MODEL;
      },
    },
    { window: 30, limits: { ...LIMITS, agentHealthWindowDays: 7 } },
  );
  assert.deepEqual(asked, [7]);
  assert.match(visibleText(page(data)), /Last 7 days, the most your plan reads/);
});

const emptyOf = (html: string) =>
  [...html.matchAll(/data-widget-empty="([^"]+)"/g)].map((match) => match[1]);
const TELEMETRY = (latestSpanAt: Date | null) => async () => ({
  hasEvents: true,
  hasSpans: latestSpanAt !== null,
  latestEventAt: AT,
  latestSpanAt,
});
const NO_MAP = topologyModel({
  agents: [],
  handoffs: [],
  servers: [],
  calls: [],
  hidden: new Set(),
  names: new Map(),
});

test("no traces: each widget says so, asks for traces, and none of them looks like a load", async () => {
  const nothing = {
    health: async () => ({ ...pendingHealthModel(7), turns: 0, floor: 50 }),
    topology: async () => NO_MAP,
  };
  const none = page(await load({ ...nothing, telemetry: TELEMETRY(null) }));
  assert.deepEqual(emptyOf(none), [
    "metrics",
    "topology-none",
    "health-no_turns",
    "attention-no-data",
    "alerts-none",
  ]);
  assert.doesNotMatch(none, /animate-pulse|role="status"|score-beat|score-wave|data-calculating/);
  assert.doesNotMatch(visibleText(none), /Nothing needs you|Calculating|of 100/);
  assert.match(visibleText(none), /Runs 0.*Spend \$0\.00/, "a zero stays a zero");

  const older = page(
    await load({ ...nothing, telemetry: TELEMETRY(new Date("2026-11-01T00:00:00.000Z")) }),
  );
  assert.deepEqual(emptyOf(older).slice(0, 2), ["metrics", "topology-window"]);
  assert.match(older, new RegExp(`href="/project/${PROJECT_ID}\\?range=30d"`));
  assert.doesNotMatch(visibleText(older), /No traces yet/);
});

test("each reason for no score keeps its own words, and only a first reading is being calculated", async () => {
  const health = async (over: Partial<HealthPageModel>) =>
    page(
      await load(
        { health: async () => ({ ...MODEL, ...over }) },
        { layout: removed("metrics", "topology", "attention", "alerts") },
      ),
    );
  const workflows = MODEL.workflows ?? ({ items: [], unserved: [] } as never);
  for (const [over, words] of [
    [{ turns: 12, floor: 50 }, /not ready yet 12 of the 50 turns a score needs\. Send more traces/],
    [{ turns: 0, floor: 50 }, /A score needs 50 turns, and the last 7 days have none/],
    [{ computedAt: null }, /Calculating the score.*Send more traces/],
    [{ workflows: { ...workflows, blocked: "no_tool_calls" as const } }, /traces with tool calls/],
    [{ workflows: { ...workflows, blocked: "mixed_runs" as const } }, /traces with turn ids/],
    [{ score: null }, /No score in this reading/],
  ] as const) {
    const html = await health(over);
    const text = visibleText(html);
    assert.match(text, words);
    assert.match(html, /data-health-score-ring="empty"/);
    assert.doesNotMatch(html, /data-ring-cell="(lit|tip|target)"|data-health-score="/);
    assert.equal(/Calculating/.test(text), "computedAt" in over);
    assert.match(html, /href="[^"]*\/health"/, "Agent health stays a click away");
  }
  const failed = page(
    await load({ health: fail }, { layout: removed("metrics", "topology", "attention", "alerts") }),
  );
  assert.deepEqual(emptyOf(failed), []);
  assert.match(visibleText(failed), /The Health score did not load\. Try again/);
});

test("alerts: no rule, all paused, no data and none firing are four states", async () => {
  const alerts = async (counts: { total: number; on: number; noData: number }) =>
    page(
      await load(
        { alertRules: async () => counts },
        { layout: removed("metrics", "topology", "attention", "health") },
      ),
    );
  const none = await alerts({ total: 0, on: 0, noData: 0 });
  assert.match(visibleText(none), /No alerts yet.*Create alert/);
  assert.match(none, /href="[^"]*\/alerts\/new"/);
  assert.match(visibleText(await alerts({ total: 2, on: 0, noData: 0 })), /All alerts are paused/);
  assert.match(visibleText(await alerts({ total: 2, on: 1, noData: 1 })), /No data to check yet/);
  assert.match(visibleText(await alerts({ total: 2, on: 2, noData: 1 })), /No alert fires now/);
  const unread = await load(
    { alertRules: fail },
    { layout: removed("metrics", "topology", "attention", "health") },
  );
  assert.match(visibleText(page(unread)), /No alert fires now/, "unread is not none");
});

test("a dashboard widget: a zero is drawn, no data says so, and a failed read is red", async () => {
  const result = (samples: number) => ({
    kind: "metric" as const,
    bucket: "day" as const,
    buckets: [],
    series: [{ groups: [], total: 0, samples, values: [] }],
  });
  assert.match(visibleText(await withItem({ ...COST_ITEM, result: result(3) })), /\$0\.00/);
  const empty = await withItem({ ...COST_ITEM, result: result(0) });
  assert.ok(emptyOf(empty).includes("item-window"));
  assert.match(
    visibleText(await withItem({ ...COST_ITEM, result: null })),
    /The numbers could not be read\. Try again/,
  );
});

test("without a score, the card says why in one line", () => {
  const line = (model: HealthPageModel | null) => {
    const card = healthCard(model);
    return card.kind === "state" ? card.line : "score";
  };
  const pending = pendingHealthModel(7);
  assert.equal(line(MODEL), "score");
  assert.equal(line(null), "The Health score did not load.");
  assert.equal(line({ ...pending, turns: 0 }), "Collecting: no turns in this window yet.");
  assert.equal(
    line({ ...pending, turns: 12, floor: 50 }),
    "Too few turns: 12 of the 50 a score needs.",
  );
  assert.equal(line({ ...MODEL, computedAt: null }), "Your first reading is being built.");
  assert.equal(line({ ...MODEL, score: undefined }), "This reading has no score.");
  const workflows = MODEL.workflows ?? ({ items: [], unserved: [] } as never);
  for (const [blocked, words] of [
    ["no_tool_calls", /no tool calls are recorded/],
    ["mixed_runs", /runs are mixed together/],
  ] as const)
    assert.match(line({ ...MODEL, workflows: { ...workflows, blocked } }), words);
});

test("a low-confidence score says so and claims no change", async () => {
  const html = page(
    await load({
      health: async () => ({
        ...MODEL,
        turns: 12,
        floor: 10,
        lowConfidence: { turns: 12, firmsUpAt: 50 },
      }),
    }),
  );
  const text = visibleText(html);
  assert.match(html, /data-overview-health="score"/);
  assert.match(text, /Low confidence: read from 12 turns\. It firms up at 50\./);
  assert.doesNotMatch(text, /since the last reading/);
});

test("nothing yet is the setup guide, and an SDK-only project is not", async () => {
  const empty = page(
    await load({ telemetry: NO_SPANS, health: async () => pendingHealthModel(7) }),
  );
  assert.match(empty, /SETUP GUIDE/);
  assert.doesNotMatch(empty, /data-topology|data-overview-health/);
  assert.match(visibleText(empty), /No data yet/);

  const sdk = page(await load({ telemetry: NO_SPANS, sdkLatestAt: async () => AT }));
  assert.doesNotMatch(sdk, /SETUP GUIDE/);
  assert.match(visibleText(sdk), /Receiving data/);
});

test("the sample project says so", async () => {
  const text = visibleText(page(await load({}, { project: { ...PROJECT, isDemo: true } })));
  assert.match(text, /Support bot is sample data/);
  assert.match(text, /Sample data/);
});

test("each failed read costs its own part only", async () => {
  const noMap = visibleText(page(await load({ topology: fail })));
  assert.match(noMap, /The map did not load/);
  assert.match(noMap, /of 100/);

  const noHealth = page(await load({ health: fail }));
  assert.match(visibleText(noHealth), /The Health score did not load/);
  assert.match(noHealth, /data-topology-node="agent"/);

  const noRuns = visibleText(page(await load({ traces: fail })));
  assert.match(noRuns, /These numbers did not load/);
  assert.match(noRuns, /of 100/);

  const unread = { traces: fail, health: fail, intents: fail };
  assert.match(visibleText(page(await load(unread))), /Needs attention did not load/);
  assert.match(visibleText(page(await load({ intents: fail }))), /Some checks did not load/);

  for (const over of [{ telemetry: fail }, { telemetry: NO_SPANS, sdkLatestAt: fail }]) {
    const html = page(await load(over));
    assert.doesNotMatch(html, /SETUP GUIDE|No data yet/, "unread is not empty");
    assert.match(html, /data-topology-node="agent"/);
  }
});

test("the Self-corrections skeleton has the crumb only where the page has one", () => {
  const skeleton = (on: boolean) =>
    visibleText(
      render(
        createElement(
          PathParamsContext.Provider,
          { value: { projectId: PROJECT_ID } },
          createElement(
            FocusedConsoleProvider,
            { value: on },
            createElement(SelfCorrectionsSkeleton),
          ),
        ),
      ),
    );
  assert.doesNotMatch(skeleton(true), /Agent health/);
  assert.match(skeleton(false), /Agent health/);
});

test("the skeleton and the tour say the recap with the flag, today's Overview without", () => {
  const skeleton = (on: boolean) =>
    render(createElement(FocusedConsoleProvider, { value: on }, createElement(OverviewSkeleton)));
  assert.match(skeleton(true), /data-skeleton="focused"/);
  assert.doesNotMatch(skeleton(false), /data-skeleton="focused"/);
  assert.equal(render(createElement(OverviewSkeleton)), skeleton(false));
  assert.equal(tourSteps(false), TOUR_STEPS);
  assert.match(tourSteps(true)[0].body, /Edit to add, remove, move and resize the widgets/);
  assert.deepEqual(tourSteps(true).slice(1), TOUR_STEPS.slice(1));
});

const BOARD = "44444444-4444-4444-8444-444444444444";
const ITEM = dashboardItemId(BOARD, "cost");
const WITH_ITEM = changeLayout(removed("topology"), {
  kind: "add",
  widget: ITEM,
  source: { title: "Cost", w: 6, h: 5 },
});
const COST_ITEM: Extract<DashboardItem, { kind: "widget" }> = {
  kind: "widget",
  title: "Cost now",
  dashboard: { name: "Board", href: `/project/${PROJECT_ID}/dashboards/${BOARD}` },
  widget: {
    ...formWidget(formOf(metricQuery("cost", "sum")), "number"),
    id: "cost",
    title: "Cost now",
    layout: { x: 0, y: 0, w: 6, h: 5 },
  },
  result: null,
  filters: {},
  range: { preset: "7d", from: "2026-11-18", to: "2026-11-24" },
};
const withItem = (item: DashboardItem, edit = false) =>
  load({ dashboards: async () => ({ [ITEM]: item }) }, { layout: WITH_ITEM }).then((data) =>
    page(data, { edit }),
  );

test("a dashboard widget is a card with its source's name now, and a link to its dashboard", async () => {
  const view = await withItem(COST_ITEM);
  const edit = await withItem(COST_ITEM, true);
  for (const html of [view, edit]) {
    assert.match(html, new RegExp(`data-card="${ITEM}"`));
    assert.match(html, /<h2[^>]*>Cost now<\/h2>/);
    assert.match(html, new RegExp(`href="/project/${PROJECT_ID}/dashboards/${BOARD}"[^>]*>Board<`));
  }
  assert.doesNotMatch(view, CONTROLS);
  assert.match(edit, /aria-label="Arrange Cost now"/);
  assert.match(edit, /aria-label="Remove Cost now"/);
});

test("a deleted source is a broken item with its old name, and a way out", async () => {
  const broken: DashboardItem = {
    kind: "broken",
    title: null,
    problem: "Its dashboard was deleted.",
  };
  const html = await withItem(broken);
  assert.match(html, /<h2[^>]*>Cost<\/h2>/);
  assert.match(visibleText(html), /This widget is broken .*Its dashboard was deleted\. .*Remove/);
  const data = await load({ dashboards: async () => ({ [ITEM]: broken }) }, { layout: WITH_ITEM });
  assert.doesNotMatch(visibleText(page(data, { save: null })), /Remove/);
});

test("the dashboard widgets that did not load say so, and cost no other widget", async () => {
  const html = page(await load({ dashboards: fail }, { layout: WITH_ITEM }));
  assert.match(visibleText(html), /This widget did not load\. Try again/);
  assert.match(visibleText(html), /Median duration/);
});

test("the picker lists the widgets by dashboard; one that is there is added, and the limit is said", () => {
  const dashboards = [
    {
      id: BOARD,
      name: "Board",
      widgets: ["Cost", "Speed"].map((title) => ({ id: title.toLowerCase(), title, w: 6, h: 5 })),
    },
  ];
  const list = (room: boolean) =>
    render(
      createElement(DashboardWidgetList, { dashboards, there: new Set([ITEM]), room, onAdd() {} }),
    );
  assert.match(list(true), /aria-label="Cost is added"/);
  assert.match(list(true), /aria-label="Add Speed of Board"/);
  assert.doesNotMatch(list(true), /Remove one first/);
  assert.match(list(false), /An Overview can have 12 dashboard widgets\. Remove one first\./);
});

test("Needs attention waits for Agent health: its progress instead of issues it cannot open", async () => {
  const attention = async (over: Partial<HealthPageModel>) =>
    page(
      await load(
        { health: async () => ({ ...MODEL, ...over }) },
        { layout: removed("metrics", "topology", "health", "alerts") },
      ),
    );
  const locked = await attention({ turns: 36, floor: 50 });
  assert.deepEqual(emptyOf(locked), ["attention-collecting"]);
  assert.match(visibleText(locked), /Agent health unlocks at 50 turns · 36\/50/);
  assert.doesNotMatch(visibleText(locked), /Nothing needs you|more in Agent health/);
  assert.match(locked, /href="[^"]*\/health"/, "Agent health stays a click away");

  const building = await attention({ computedAt: null });
  assert.match(visibleText(building), /Agent health is building its first reading/);
});
