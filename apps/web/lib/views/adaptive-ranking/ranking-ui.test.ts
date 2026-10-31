// The runner only picks up `.ts`, so components are built with createElement.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  type RankingGraphView,
  RankingView,
} from "@/components/console/adaptive-ranking/RankingView";
import type { EvaluableSelection } from "@/lib/synthesis/quality/ground-truth";
import { buildBoostView } from "@/lib/views/adaptive-ranking/boost-view";
import {
  graphGrowth,
  rankingChecklist,
  rankingCurve,
  rankingHeadline,
  servingState,
} from "@/lib/views/adaptive-ranking/ranking";

const PROJECT = "p1";

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

function checklist() {
  return rankingChecklist([
    {
      key: "events",
      label: "Send searches and tool calls",
      detail: "3 runtimes sent searches.",
      state: "done",
    },
    {
      key: "building",
      label: "Cloud builds the intent map",
      detail: "The first map appears soon.",
      state: "pending",
    },
    {
      key: "connected",
      label: "Rank from the graph in your runtime",
      detail: "Add these lines.",
      state: "pending",
      snippet: "attach(runtime);",
    },
    {
      key: "following",
      label: "Keep up with new revisions",
      detail: "Cloud checks adoption.",
      state: "pending",
    },
  ]);
}

test("Adaptive ranking with no graph lays the setup out as a visible, numbered checklist", () => {
  const html = renderToStaticMarkup(
    inApp(
      `/project/${PROJECT}/improvement/adaptive-ranking`,
      createElement(RankingView, {
        title: "Adaptive ranking",
        crumbs: [{ label: "Improvements", href: `/project/${PROJECT}/improvement` }],
        choices: [],
        defaultKey: "cloud",
        graph: null,
        intentsHref: `/project/${PROJECT}/intents`,
        emptyChecklist: checklist(),
      }),
    ),
  );
  assert.match(html, /<h1[^>]*>Adaptive ranking<\/h1>/);
  assert.match(html, /<a[^>]*href="\/project\/p1\/improvement"[^>]*>Improvements<\/a>/);
  assert.match(html, /aria-label="Set up adaptive ranking" data-ranking-empty=""/);
  assert.match(html, />No ranking to show yet</);
  assert.match(html, /<ol aria-label="Set up adaptive ranking"/);
  assert.deepEqual(
    [...html.matchAll(/<li data-state="([a-z]+)"/g)].map((match) => match[1]),
    ["done", "current", "todo", "todo"],
    "done, the one to do now, then the ones that wait",
  );
  assert.match(html, />Next</);
  assert.doesNotMatch(html, /attach\(runtime\)/, "a snippet shows only on the step to do now");
  assert.doesNotMatch(html, /aria-expanded/, "nothing folded away");
  assert.doesNotMatch(html, /\u2014/);
});

function rankingGraph(): RankingGraphView {
  const selections: EvaluableSelection[] = Array.from({ length: 400 }, (_, index) => ({
    selectionId: `s-${index}`,
    occurredAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)),
    query: null,
    arms: [
      {
        arm: "baseline",
        role: "serving",
        resultIds: index % 10 < 7 ? ["right", "other"] : ["other", "right"],
      },
      {
        arm: "adaptive",
        role: "shadow",
        resultIds: index % 10 < 8 ? ["right", "other"] : ["other", "right"],
      },
    ],
    invokedToolId: "right",
    invokedRank: null,
  }));
  const view = buildBoostView(selections, { estimated: true });
  const serving = servingState("cloud", "watching");
  return {
    choice: { graphKey: "cloud", label: "All runtimes", origin: "cloud" },
    serving,
    headline: rankingHeadline(view, serving.served),
    curve: rankingCurve(view),
    growth: graphGrowth({ maturity: 0.94, clusterCount: 30, byteSize: 11_602 }),
    checklist: rankingChecklist([
      {
        key: "connected",
        label: "Rank from the graph in your runtime",
        detail: "Add these lines.",
        state: "pending",
        snippet: "attach(runtime);",
      },
      {
        key: "following",
        label: "Keep up with new revisions",
        detail: "Cloud checks adoption.",
        state: "pending",
      },
    ]),
    warnings: [],
    details: {
      searches: 100,
      estimated: true,
      metrics: [
        {
          id: "recall@1",
          label: "Recall@1",
          meaning: "The tool the agent ran came first",
          without: 0.7,
          withGraph: 0.8,
          share: true,
        },
      ],
      verdict: { better: 10, worse: 0, same: 90 },
      liveRecall: null,
      facts: [{ label: "Revision", value: "698" }],
      clusters: [
        {
          id: "intent_63",
          label: "Create a task",
          support: 70,
          phrasings: 3,
          topTool: "acme",
          lastSeen: "Just now",
        },
      ],
      clusterTotal: 1,
    },
  };
}

test("Adaptive ranking leads with whether it is served and one plain headline; the numbers wait behind Details", () => {
  const html = renderToStaticMarkup(
    inApp(
      `/project/${PROJECT}/improvement/adaptive-ranking`,
      createElement(RankingView, {
        title: "Adaptive ranking",
        crumbs: [{ label: "Improvements", href: `/project/${PROJECT}/improvement` }],
        choices: [],
        defaultKey: "cloud",
        graph: rankingGraph(),
        intentsHref: `/project/${PROJECT}/intents`,
        emptyChecklist: [],
      }),
    ),
  );
  assert.match(html, /data-ranking-state="better" data-served="false"/);
  assert.match(html, />Not served yet</);
  assert.match(
    html,
    /<h2 id="ranking-answer"[^>]*>Would find the right tool first 14% more often<\/h2>/,
  );
  assert.match(
    html,
    /on 80% of 400 searches that reported the tool the agent ran, against 70% without it\./,
  );
  assert.match(
    html,
    /data-ranking-notes=""[\s\S]*Estimated by replaying your searches on Cloud&#x27;s keyword index/,
    "an estimate says so",
  );
  assert.match(html, /<a[^>]*href="\/project\/p1\/intents"[^>]*>See the intents/);
  assert.match(html, /role="meter" aria-label="Learned 94%"/);
  assert.match(html, />Start serving it</);
  const details = html.indexOf(">Details<");
  assert.ok(details > 0, "a Details disclosure");
  assert.match(
    html,
    /<button[^>]*aria-expanded="false"[^>]*>(?:(?!<\/button>)[\s\S])*Details/,
    "closed by default",
  );
  assert.match(
    html.slice(details),
    /<div[^>]*hidden=""[^>]*>[\s\S]*Recall@1/,
    "its panel is hidden until opened",
  );
  const lead = html.slice(0, details);
  assert.doesNotMatch(
    lead,
    /Recall@|nDCG|MRR|intent_63|min\(1/,
    "no metrics, formula or ids before Details",
  );
  assert.match(html.slice(details), /Recall@1[\s\S]*intent_63/, "they are all there behind it");
  assert.doesNotMatch(html, /\u2014/);
});

// What people asked, as the engine read it: text in the panel, never an attribute.
