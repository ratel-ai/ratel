import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { QualityEvidence } from "./load-misses";
import type { MissRow } from "./miss-rows";

/**
 * Test helpers for the Quality v2 render tests: the router contexts the
 * client parts read (pathname, query, router), and small fixtures. Kept out
 * of the `.test.ts` files so each stays about one tab.
 */

const ROUTER = {
  back() {},
  forward() {},
  prefetch() {},
  push() {},
  replace() {},
  refresh() {},
  hmrRefresh() {},
} as unknown as AppRouterInstance;

export const NOW = new Date("2026-10-15T12:00:00.000Z");
export const ROOT = "/project/p1";

/** Static markup with the app router mounted at `pathname?search`. */
export function render(
  node: ReactElement,
  { pathname = `${ROOT}/quality`, search = "" } = {},
): string {
  return renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: ROUTER },
      createElement(
        PathnameContext.Provider,
        { value: pathname },
        createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) }, node),
      ),
    ),
  );
}

/** The words a reader sees: markup stripped, so class names never count as copy. */
export function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

export function missRow(overrides: Partial<MissRow> = {}): MissRow {
  return {
    id: "sel-deploy",
    selectionIds: ["sel-deploy", "sel-old"],
    query: "deploy to staging",
    expected: { id: "vercel_promote_deployment", name: "vercel_promote_deployment" },
    rankedFirst: { id: "flaky_deploy_api", name: "flaky_deploy_api" },
    rank: 4,
    evidence: "seen",
    count: 6,
    lastSeen: "2026-10-15T03:00:00.000Z",
    ours: {
      arm: "ratel",
      served: true,
      items: [
        { id: "flaky_deploy_api", name: "flaky_deploy_api" },
        { id: "vercel_get_deployment_logs", name: "vercel_get_deployment_logs" },
        { id: "vercel_list_deployments", name: "vercel_list_deployments" },
        { id: "vercel_promote_deployment", name: "vercel_promote_deployment" },
      ],
      more: 0,
    },
    comparison: null,
    comparisonRank: null,
    traceHref: null,
    test: { kind: "query", query: "deploy to staging" },
    rewrite: null,
    ...overrides,
  };
}

export function evidence(overrides: Partial<QualityEvidence> = {}): QualityEvidence {
  return {
    searches: 312,
    answered: 281,
    headline: {
      tier: "judged",
      n: 140,
      hits: 88,
      share: 0.63,
      change: { direction: "up", text: "+6 pts" },
      trend: [0.5, null, 0.7, 0, 0.66, 0.6, 0.63],
      trendUnit: "day",
    },
    found: {
      tier: "judged",
      n: 140,
      hits: 112,
      share: 0.8,
      change: { direction: "up", text: "+3 pts" },
      trend: [0.7, null, 0.8, 0.75, 0.82, 0.79, 0.8],
      trendUnit: "day",
    },
    theirs: null,
    tools: {},
    groups: [],
    missCount: 2,
    cut: false,
    readLimit: 5000,
    source: { kind: "telemetry" },
    experimentName: "ratel:search-telemetry",
    ...overrides,
  };
}

/** The two listed misses `evidence()` counts. */
export function missRowsFixture(): MissRow[] {
  return [
    missRow(),
    missRow({
      id: "sel-task",
      selectionIds: ["sel-task"],
      query: "create a task",
      evidence: "judged",
      rank: null,
      count: 15,
    }),
  ];
}
