import assert from "node:assert/strict";
import { test } from "node:test";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArmRoleMix } from "@/components/console/calibration/ArmRoleMix";
import {
  ComparisonBrowser,
  comparisonContentMode,
} from "@/components/console/calibration/ComparisonBrowser";
import { ComparisonCensusTiles } from "@/components/console/calibration/ComparisonCensusTiles";
import { COMPARISON_ROW_GRID, ComparisonRow } from "@/components/console/calibration/ComparisonRow";
import { SelectionRankingDiff } from "@/components/console/calibration/SelectionRankingDiff";
import type { RankingComparisonRowView } from "@/lib/synthesis/experiments/calibration-types";

/**
 * The Playground link on a comparison row is a client `Link` that prefetches
 * through `useRouter`, so a bare `renderToStaticMarkup` throws "app router to be
 * mounted". Supplying the context renders the row the way the app does.
 */
function withAppRouter(children: ReactNode): ReactElement {
  const router = {
    push: () => {},
    replace: () => {},
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  };
  return createElement(AppRouterContext.Provider, { value: router as never }, children);
}

test("census tiles headline paired comparisons and the mismatch share", () => {
  const html = renderToStaticMarkup(
    createElement(ComparisonCensusTiles, {
      census: { kind: "ranking-shadow", comparisonCount: 42, mismatchCount: 5 },
    }),
  );

  assert.match(html, />42</);
  assert.match(html, />comparisons</);
  assert.match(html, />5</);
  assert.match(html, />mismatches</);
  // 5/42 = 11.9% → whole-percent share, so the index never implies precision
  // the census does not have.
  assert.match(html, />12%</);
});

test("census tiles omit the share rather than dividing by a zero census", () => {
  const html = renderToStaticMarkup(
    createElement(ComparisonCensusTiles, {
      census: { kind: "ranking-shadow", comparisonCount: 0, mismatchCount: 0 },
    }),
  );

  assert.doesNotMatch(html, /NaN|Infinity|%/);
});

test("ranking diff exposes matching rows for linked hover and keyboard focus", () => {
  const html = renderToStaticMarkup(
    createElement(SelectionRankingDiff, {
      servedArm: "legacy",
      shadowArm: "ratel",
      servedResultIds: ["pippo", "pluto"],
      shadowResultIds: ["pluto", "pippo"],
      servedResultScores: [1, 0.8],
      shadowResultScores: [0.9, 0.7],
    }),
  );

  assert.equal(html.match(/data-ranking-id="pippo"/g)?.length, 2);
  assert.equal(html.match(/tabindex="0"/g)?.length, 4);
});

test("comparison browser renders the filtered page it was given", () => {
  const html = renderToStaticMarkup(
    withAppRouter(
      createElement(ComparisonBrowser, {
        initialPage: { rows: [comparisonRow()], total: 51 },
        initialView: {
          selection: { scope: "mismatch", facets: ["missing"], match: "any" },
          page: 2,
          pageSize: 25,
          offset: 25,
        },
        projectId: "project-1",
        experimentName: "reranker-shadow",
        basePath: "/project/project-1/calibration",
        rangeSearch: "project=acme&range=24h",
      }),
    ),
  );

  assert.match(html, /mark the task done/);
  assert.match(
    html,
    /href="\/project\/project-1\/calibration\/~reranker-shadow\/selection\/sel-1\?/,
  );
  assert.match(html, /Top-1 mismatch/);
  assert.match(html, /Reordered/);
  assert.match(html, /Missing/);
  assert.match(html, /Added/);
  assert.match(html, /Outcome/);
  assert.match(html, /26–26 of 51/);
  assert.match(html, /Page 2 of 3/);
  assert.match(html, /25 per page/);
  assert.match(html, />When</);
  assert.match(html, />Query</);
  assert.match(html, /Served top-1/);
  assert.match(html, /Shadow top-1/);
  assert.match(html, />Changes</);
  assert.match(html, /Latency difference/);
  assert.doesNotMatch(html, />Outcomes</);
  assert.doesNotMatch(html, />trace</);
  // The heading names the active facet, so the filter is legible at a glance.
  assert.match(html, /Flagged mismatches: missing tools/);
});

test("comparison row keeps only top results and change counts in its summary", () => {
  const html = renderToStaticMarkup(
    createElement(ComparisonRow, {
      row: comparisonRow(),
      index: 0,
      animate: false,
      href: "/selection/sel-1",
      open: false,
      onToggle: () => {},
    }),
  );
  assert.match(html, /<summary/);
  const summary = html.slice(html.indexOf("<summary"), html.indexOf("</summary>"));

  assert.match(summary, /get_document_content/);
  assert.match(summary, /search_document_chunks/);
  // Signed counts, not "2 moved" in a pill: sign and colour carry the direction.
  assert.match(summary, /↕2/);
  assert.doesNotMatch(summary, /moved|dropped|added/);
  assert.doesNotMatch(summary, /100%|top-1 ✗|order ✗|k=2|inspect/);
  assert.match(html, /data-comparison-detail/);
  assert.match(html, /k=2/);
  assert.match(html, /legacy · ok/);
  assert.match(html, /ratel · ok/);
  assert.match(html, /inspect →/);
});

test("the summary shows the latency difference, not both timings", () => {
  // "812ms → 36ms" plus a delta chip made the reader subtract; the row states
  // the answer and keeps the raw pair in the title.
  const html = renderToStaticMarkup(
    createElement(ComparisonRow, {
      row: comparisonRow(),
      index: 0,
      animate: false,
      href: null,
      open: false,
      onToggle: () => {},
    }),
  );
  const summary = html.slice(html.indexOf("<summary"), html.indexOf("</summary>"));
  // Fixture: served 120ms, shadow 80ms. The row states the 40ms the reader
  // would otherwise have to work out, and keeps the pair in the title.
  assert.match(summary, /−40ms/);
  assert.match(summary, /title="shadow 80ms vs served 120ms"/);
  assert.doesNotMatch(summary, /→/);
});

test("an open row renders its details expanded", () => {
  const html = renderToStaticMarkup(
    createElement(ComparisonRow, {
      row: comparisonRow(),
      index: 0,
      animate: false,
      href: null,
      open: true,
      onToggle: () => {},
    }),
  );
  // Open state is owned by the browser so only one row can be expanded.
  assert.match(html, /<details[^>]*\bopen\b/);
});

test("comparison columns reserve the same action track in headers and rows", () => {
  assert.match(COMPARISON_ROW_GRID, /_2rem\]$/);
});

test("comparison browser keeps existing rows mounted while loading", () => {
  assert.equal(comparisonContentMode("loading", 25), "rows");
  assert.equal(comparisonContentMode("loading", 0), "skeleton");
});

// Upstream also renders its trace calibration card (ExperimentBanner) here; the Traces pages
// of this edition do not carry that card, so the case is left out (ADR-0030).

test("arm summary shows the serving and shadowing share for each arm", () => {
  const html = renderToStaticMarkup(
    createElement(ArmRoleMix, {
      arms: [
        {
          arm: "legacy",
          servingCount: 7,
          shadowingCount: 3,
          servingRate: 0.7,
          shadowingRate: 0.3,
        },
        {
          arm: "ratel",
          servingCount: 3,
          shadowingCount: 7,
          servingRate: 0.3,
          shadowingRate: 0.7,
        },
      ],
    }),
  );

  assert.match(html, /legacy/);
  assert.match(html, /ratel/);
  assert.equal(html.match(/>70%</g)?.length, 2);
  assert.equal(html.match(/>30%</g)?.length, 2);
});

function comparisonRow(): RankingComparisonRowView {
  return {
    selectionId: "sel-1",
    occurredAt: new Date("2026-08-10T12:00:00.000Z"),
    traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    query: "mark the task done",
    servedArm: "legacy",
    shadowArm: "ratel",
    servedOutcome: "ok",
    shadowOutcome: "ok",
    servedDurationMs: 120,
    shadowDurationMs: 80,
    top1: false,
    exactOrder: false,
    agreementK: 2,
    matchScore: 1,
    servedResultIds: ["get_document_content", "search_tasks"],
    shadowResultIds: ["search_document_chunks", "search_tasks"],
    servedResultScores: [1, 0.8],
    shadowResultScores: [0.9, 0.7],
    diffSummary: { stable: 0, moved: 2, dropped: 0, added: 0 },
  };
}
