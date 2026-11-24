// First: lets node load the components' stylesheet imports, and gives the router contexts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { PathParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { createElement } from "react";
import { FocusedHealthView } from "@/components/console/health/focused/FocusedHealthView";
import { FocusedOverviewView } from "@/components/console/home/focused/FocusedOverviewView";
import type { SaveLayout } from "@/components/console/home/focused/OverviewLayout";
import { OverviewSkeleton } from "@/components/console/home/OverviewSkeleton";
import { SelfCorrectionsSkeleton } from "@/components/console/self-corrections/SelfCorrectionsSkeleton";
import { FocusedConsoleProvider } from "@/components/console/shell/focused-console-context";
import { TOUR_STEPS, tourSteps } from "@/lib/console/onboarding/tour-steps";
import {
  HEALTH_SCORE_VERSION,
  healthScoreView,
  scoredIssues,
} from "@/lib/readings/trace-signals/health-score";
import { type HealthPageModel, windowOptionsForPlan } from "@/lib/readings/trace-signals/view";
import { MOCK_HEALTH_MODEL } from "@/lib/views/health/mock-fixture";
import { pendingHealthModel } from "@/lib/views/health/page-model";
import {
  type FocusedOverviewData,
  type FocusedReads,
  healthCard,
  loadFocusedOverview,
} from "@/lib/views/home/focused-load";
import {
  changeLayout,
  DEFAULT_LAYOUT,
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

const SAVE: SaveLayout = async () => ({ ok: true, layout: DEFAULT_LAYOUT });

function page(
  data: FocusedOverviewData,
  { linked = true, save = SAVE }: { linked?: boolean; save?: SaveLayout | null } = {},
): string {
  const html = render(
    createElement(FocusedOverviewView, { data, now: NOW, linked, save, setup: "SETUP GUIDE" }),
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

const order = (html: string) =>
  [...html.matchAll(/data-overview-widget="(\w+)"/g)].map((match) => match[1]);
const hide = (...ids: OverviewWidgetId[]) =>
  ids.reduce<OverviewLayout>(
    (layout, widget) => changeLayout(layout, { kind: "hide", widget }),
    DEFAULT_LAYOUT,
  );

test("without a stored layout: Metrics, Topology, then Health with Needs attention beside it", async () => {
  const html = page(await load());
  assert.deepEqual(order(html), ["metrics", "topology", "health", "attention"]);
  const headings = [...html.matchAll(/<h2[^>]*>([^<]+)</g)].map((match) => match[1]);
  assert.deepEqual(headings, [
    "Metrics",
    "Agents and MCP servers",
    "Health score",
    "Needs attention",
  ]);
  const places = [...html.matchAll(/--cell-column:([^;"]+);--cell-row:([^;"]+)/g)];
  assert.equal(places.length, 4, "the server draws the places");
  assert.equal(places[2][2], places[3][2], "Health and Needs attention share their rows");
  const text = visibleText(html);
  assert.match(text, /Receiving data/);
  assert.match(text, /Runs .*Failed runs .*Median duration .*Spend/);
  for (const dropped of ["Recent runs", "Intents", "Self-corrections"])
    assert.ok(!text.includes(dropped), `no "${dropped}"`);
});

test("the page is the person's layout: their order, and no hidden widget", async () => {
  const moved = changeLayout(hide("topology"), { kind: "move", widget: "attention", x: 4, y: 0 });
  assert.deepEqual(order(page(await load({}, { layout: moved }))), [
    "attention",
    "metrics",
    "health",
  ]);
  for (const id of OVERVIEW_WIDGETS) {
    const others = OVERVIEW_WIDGETS.filter((other) => other !== id);
    assert.deepEqual(order(page(await load({}, { layout: hide(...others) }))), [id], "alone");
  }
});

test("all hidden is one quiet line with Customize", async () => {
  const html = page(await load({}, { layout: hide(...OVERVIEW_WIDGETS) }));
  assert.deepEqual(order(html), []);
  assert.match(html, /data-overview-hidden="all"[^>]*>Every widget is hidden\.<button/);
});

test("a person arranges by the header, the menu and Customize; a support session has none of them", async () => {
  const data = await load();
  const html = page(data);
  assert.equal((html.match(/data-grid-handle/g) ?? []).length, 4);
  for (const title of ["Metrics", "Agents and MCP servers", "Health score", "Needs attention"])
    assert.match(html, new RegExp(`aria-label="Arrange ${title}"`));
  assert.match(visibleText(html), /Customize/);
  const support = page(data, { save: null });
  assert.deepEqual(order(support), order(html));
  assert.doesNotMatch(support, /data-grid-handle|aria-label="Arrange|Customize/);
});

test("each widget links to the page behind it", async () => {
  const html = page(await load());
  for (const [label, path] of [
    ["Open Traces", "traces\\?range=7d"],
    ["Open Agents", "agents"],
    ["Open Agent health", "health\\?days=7"],
  ])
    assert.match(
      html,
      new RegExp(
        `aria-label="${label}"[^>]*href="/project/${PROJECT_ID}/${path}|href="/project/${PROJECT_ID}/${path}[^"]*"[^>]*aria-label="${label}"|aria-label="${label}"`,
      ),
    );
  assert.doesNotMatch(page(await load(), { linked: false }), /Open Agents"/);
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
  assert.match(tourSteps(true)[0].body, /Drag, resize and hide the widgets/);
  assert.deepEqual(tourSteps(true).slice(1), TOUR_STEPS.slice(1));
});
