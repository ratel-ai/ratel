// First: lets node load the components' stylesheet imports, and gives the router contexts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { FocusedHealthView } from "@/components/console/health/focused/FocusedHealthView";
import { FocusedOverviewView } from "@/components/console/home/focused/FocusedOverviewView";
import { OverviewSkeleton } from "@/components/console/home/OverviewSkeleton";
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
import { topologyModel } from "@/lib/views/project-entities/topology";
import { PROJECT_ID, render, visibleText } from "@/lib/views/tasks/test-support";
import { findDsViolations } from "../../../../eslint-rules/ds-tokens.mjs";

/** The Overview: what it reads, and every state it draws. */

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

function page(data: FocusedOverviewData, linked = true): string {
  const html = render(
    createElement(FocusedOverviewView, { data, now: NOW, linked, setup: "SETUP GUIDE" }),
    { pathname: `/project/${PROJECT_ID}` },
  );
  const violations = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => findDsViolations(m[1]));
  assert.deepEqual([...new Set(violations)], [], "semantic tokens only");
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1, "one h1");
  assert.doesNotMatch(visibleText(html), /—/, "no em dash");
  return html;
}

test("reads telemetry, the health model and the topology, and the context only for its Panel", async () => {
  const closed = reads();
  await load({}, { reads: closed.reads });
  assert.deepEqual(closed.ran.sort(), ["health", "sdkLatestAt", "telemetry", "topology"]);
  const open = reads();
  await load({}, { reads: open.reads, contextOpen: true });
  assert.deepEqual(open.ran.sort(), ["context", "health", "sdkLatestAt", "telemetry", "topology"]);
});

test("the page is the header, the health card and the topology", async () => {
  const html = page(await load());
  const headings = [...html.matchAll(/<h2[^>]*>([^<]+)</g)].map((match) => match[1]);
  assert.deepEqual(headings, ["Health score", "Agents and MCP servers"]);
  const text = visibleText(html);
  assert.match(text, /Receiving data/);
  assert.match(text, /7 days/);
  for (const dropped of ["Needs attention", "Recent runs", "Spend", "Intents", "Self-corrections"])
    assert.ok(!text.includes(dropped), `no "${dropped}"`);
});

test("the card shows Agent health's value, change and points, and opens it in its window", async () => {
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
  const lost = [...html.matchAll(/data-health-lost="\w+".*?<span[^>]*>(?:−(\d+) pts|0)</g)];
  assert.equal(lost.length, 4);
  assert.equal(
    lost.reduce((sum, match) => sum + Number(match[1] ?? 0), 0),
    100 - SCORE.value,
  );
  assert.match(visibleText(html), /since the last reading/);
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

  for (const over of [{ telemetry: fail }, { telemetry: NO_SPANS, sdkLatestAt: fail }]) {
    const html = page(await load(over));
    assert.doesNotMatch(html, /SETUP GUIDE|No data yet/, "unread is not empty");
    assert.match(html, /data-topology-node="agent"/);
  }
});

test("the skeleton draws the Health card and the map", () => {
  const html = render(createElement(OverviewSkeleton));
  assert.match(html, /Loading page/);
  assert.match(html, /h-64[\s\S]*h-96/);
});
