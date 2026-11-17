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
import { SessionListView } from "@/components/console/traces-sessions/SessionListView";
import { EMPTY_TRACE_FILTER_FACETS } from "@/lib/synthesis/traces/trace-filters";

/** RC-506: the property bar on Sessions shows when its filter facets are given. */

const PROJECT = "6b64f504-f84f-447a-afe4-fb84054735fb";
const ROOT = `/project/${PROJECT}/traces`;

function inRouter(search: string, children: ReactNode): ReactElement {
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
      createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) }, children),
    ),
  );
}

function render(search: string, filterFacets: typeof EMPTY_TRACE_FILTER_FACETS | null): string {
  const view = createElement(SessionListView, {
    projectId: PROJECT,
    filter: "all",
    rows: [],
    nextCursor: null,
    now: "2026-11-10T09:00:00.000Z",
    empty: filterFacets ? "filtered" : "no-telemetry",
    filterFacets,
  });
  return renderToStaticMarkup(inRouter(search, view));
}

test("with the flag off, Sessions shows no filter bar", () => {
  const html = render("?facetModel=gpt-4o", null);
  assert.doesNotMatch(html, /aria-label="Filters"/);
  assert.doesNotMatch(html, /Model is/);
});

test("with the flag on, Sessions shows the bar with the URL's chips and no name search", () => {
  const html = render("?facetModel=gpt-4o&facetTool=refund", EMPTY_TRACE_FILTER_FACETS);
  assert.match(html, /aria-label="Filters"/);
  assert.match(html, /Model is/);
  assert.match(html, /gpt-4o/);
  assert.match(html, /Tool is/);
  assert.doesNotMatch(html, /role="search"/);
  assert.match(html, /No sessions match/);
});
