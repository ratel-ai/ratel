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
import { PivotBreakdownTable } from "@/components/console/home/PivotBreakdownTable";
import { pivotGroupRowViews } from "@/lib/synthesis/pivots/group-by-view";

/** RC-886: the Overview group-by table shows each value, Other and (none), and links a value to Sessions. */

const ROOT = "/project/p1";

function inRouter(children: ReactNode): ReactElement {
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
      { value: ROOT },
      createElement(
        SearchParamsContext.Provider,
        { value: new URLSearchParams("range=30d") },
        children,
      ),
    ),
  );
}

const ROWS = pivotGroupRowViews(
  {
    rows: [
      { kind: "value", value: "acme", runs: 3, errorRate: 1 / 3, p50Ms: 200, costUsd: 0.3 },
      { kind: "other", value: null, runs: 2, errorRate: 0, p50Ms: 90, costUsd: 0.1 },
      { kind: "none", value: null, runs: 1, errorRate: 1, p50Ms: 10, costUsd: 0 },
    ],
    totalRuns: 6,
  },
  "client",
  ROOT,
);

test("the table has a row per value, Other and (none), and a value links to filtered Sessions", () => {
  const html = renderToStaticMarkup(
    inRouter(
      createElement(PivotBreakdownTable, {
        pivots: [{ key: "client", label: "Client company" }],
        pivotKey: "client",
        pivotLabel: "Client company",
        rows: ROWS,
      }),
    ),
  );
  assert.match(html, /href="\/project\/p1\/traces\?pivot\.client=acme"/);
  assert.match(html, />Other</);
  assert.match(html, />\(none\)</);
  assert.match(html, />Client company</);
  // One pivot: no picker.
  assert.doesNotMatch(html, /aria-label="Group runs by"/);
});

test("with more than one pivot the table offers the picker", () => {
  const pivots = [
    { key: "client", label: "Client company" },
    { key: "end_user", label: "End user" },
  ];
  const html = renderToStaticMarkup(
    inRouter(
      createElement(PivotBreakdownTable, {
        pivots,
        pivotKey: "client",
        pivotLabel: "Client company",
        rows: ROWS,
      }),
    ),
  );
  assert.match(html, /aria-label="Group runs by"/);
  assert.match(html, /End user/);
});
