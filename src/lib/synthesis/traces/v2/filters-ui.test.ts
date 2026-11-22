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

// — RC-790: the Agent and MCP server filters, behind cloud-project-entities —

const ENTITY_SEARCH = "?facetModel=gpt-4o&facetAgent=researcher&facetServer=docs-mcp";

function renderEntities(entities: boolean | undefined): string {
  const view = createElement(SessionListView, {
    projectId: PROJECT,
    filter: "all",
    rows: [],
    nextCursor: null,
    now: "2026-11-10T09:00:00.000Z",
    empty: "filtered",
    filterFacets: {
      ...EMPTY_TRACE_FILTER_FACETS,
      ...(entities
        ? { agent: [{ value: "researcher", count: 2 }], server: [{ value: "docs-mcp", count: 1 }] }
        : {}),
    },
    ...(entities === undefined ? {} : { entities }),
  });
  return renderToStaticMarkup(inRouter(ENTITY_SEARCH, view));
}

test("with cloud-project-entities on, the bar shows the agent and MCP server chips from the URL", () => {
  const html = renderEntities(true);
  assert.match(html, /Model is/);
  assert.match(html, /Agent is/);
  assert.match(html, /researcher/);
  assert.match(html, /MCP server is/);
  assert.match(html, /docs-mcp/);
});

test("with cloud-project-entities off, facetAgent and facetServer in the URL show no chip", () => {
  for (const entities of [false, undefined]) {
    const html = renderEntities(entities);
    assert.match(html, /Model is/, "the other filters are as before");
    assert.doesNotMatch(html, /Agent is/);
    assert.doesNotMatch(html, /MCP server is/);
    // The values stay only in the tab links, which keep the query string as before.
    assert.doesNotMatch(html, />researcher<|>docs-mcp</);
  }
});

// — RC-885: the "pivot is" filters —

function renderPivots(pivots: readonly { key: string; label: string }[] | undefined): string {
  const view = createElement(SessionListView, {
    projectId: PROJECT,
    filter: "all",
    rows: [],
    nextCursor: null,
    now: "2026-11-10T09:00:00.000Z",
    empty: "filtered",
    filterFacets: {
      ...EMPTY_TRACE_FILTER_FACETS,
      pivots: { client: [{ value: "acme", count: 2 }] },
    },
    pivots,
  });
  return renderToStaticMarkup(inRouter("?pivot.client=acme&pivot.secret=x", view));
}

test("the bar shows a configured pivot's chip with its label and raw value", () => {
  const html = renderPivots([{ key: "client", label: "Client company" }]);
  assert.match(html, /Client company is<\/span><span class="font-medium text-fg">acme</);
  // A key that is not configured is no filter: one chip only.
  assert.equal(html.match(/aria-label="Remove /g)?.length, 1);
});

test("with no pivot configured, pivot parameters in the URL show no chip", () => {
  for (const pivots of [undefined, []]) {
    const html = renderPivots(pivots);
    assert.doesNotMatch(html, /Client company is/);
    assert.doesNotMatch(html, /aria-label="Remove /);
  }
});
