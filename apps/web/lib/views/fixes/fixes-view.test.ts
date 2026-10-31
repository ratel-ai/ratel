import assert from "node:assert/strict";
import { test } from "node:test";
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
import { FixDetail } from "@/components/console/fixes/FixDetail";
import { FixesPage } from "@/components/console/fixes/FixesPage";
import { FixesSkeleton } from "@/components/console/fixes/FixesSkeleton";
import { buildFixes } from "@/lib/views/fixes/build";
import { findFix } from "@/lib/views/fixes/select";
import { fixesInput, NOW } from "@/lib/views/fixes/test-fixtures";
import type { FixesModel } from "@/lib/views/fixes/types";

const ROUTER = {
  back() {},
  forward() {},
  prefetch() {},
  push() {},
  replace() {},
  refresh() {},
  hmrRefresh() {},
} as unknown as AppRouterInstance;

const PATH = "/project/p1/improvement/fixes";

function render(node: ReactElement, search = ""): string {
  return renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: ROUTER },
      createElement(
        PathnameContext.Provider,
        { value: PATH },
        createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) }, node),
      ),
    ),
  );
}

/** The words a reader sees: markup and inline styles stripped, so class names never count as copy. */
function visibleText(html: string): string {
  return html
    .replace(/<style>[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

const model = buildFixes(fixesInput());
const page = (over: Partial<FixesModel> = {}, search = "") =>
  render(
    createElement(FixesPage, {
      projectId: "p1",
      model: { ...model, ...over },
      now: NOW.toISOString(),
    }),
    search,
  );

/** Words the product never shows (DESIGN.md, The product's nouns). */
const FORBIDDEN = /workflow|tool craft|suggestion|proposal|signal|craft|jev|bm25|topic|\u2014/i;

/** One table's markup, from its anchor to the next table's. */
function table(html: string, group: string): string {
  const start = html.indexOf(`id="fixes-${group}"`);
  assert.ok(start >= 0, `no ${group} table`);
  const next = html.indexOf('id="fixes-', start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

/** The body rows of a table's markup. */
function rows(html: string): string[] {
  const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
  return body.split("<tr").slice(1);
}

test("one h1 under its crumb, one sentence, the numbers as marks, then the tables", () => {
  const html = page();
  assert.equal(html.match(/<h1/g)?.length, 1);
  assert.match(html, /<h1[^>]*>Fixes<\/h1>/);
  assert.match(html, /<a[^>]*href="\/project\/p1\/improvement"[^>]*>Improvements<\/a>/);
  assert.match(html, /Changes that would make your agent find and finish more\./);
  const text = visibleText(html);
  // Open fixes, with a jump to each table by its mark and count.
  assert.match(text, /Open fixes 8 2 update descriptions 5 change your tools 1 ranking settings/);
  assert.match(html, /href="#fixes-descriptions"/);
  assert.match(html, /href="#fixes-tools"/);
  // Evidence as pixels in its colors, the count of the strong ones leading.
  assert.match(text, /Strong evidence 5 2 solid 1 early/);
  assert.match(html, /role="img" aria-label="Evidence: 5 strong, 2 solid, 1 early"/);
  assert.match(text, /Issues they resolve 8 On Agent health/);
  assert.match(text, /Model calls saved 46/);
  assert.match(text, /8 open fixes/);
});

test("one table per thing you do, each with its mark, its count and one line", () => {
  const html = page();
  const text = visibleText(html);
  assert.match(
    text,
    /Update descriptions 2 Words that get the right tool found\. You apply them on Quality\./,
  );
  assert.match(
    text,
    /Change your tools 5 Changes in your tool server\. Copy a prompt for your coding agent\./,
  );
  assert.match(text, /Ranking settings 1 How many results each search returns\./);
  // A table with nothing in it is left out.
  assert.doesNotMatch(text, /Add skills/);
  assert.match(
    html,
    /<caption class="sr-only">Update descriptions, biggest effect first<\/caption>/,
  );
  assert.match(html, /<caption class="sr-only">Change your tools, biggest effect first<\/caption>/);
  // Tables in the order you would work through them.
  assert.ok(html.indexOf('id="fixes-descriptions"') < html.indexOf('id="fixes-tools"'));
  assert.ok(html.indexOf('id="fixes-tools"') < html.indexOf('id="fixes-ranking"'));
});

test("a row: the kind's mark and the verb-first title, pins, one effect, evidence in color", () => {
  const html = page();
  const tools = table(html, "tools");
  const merge = rows(tools)[0]!;
  // The title says what to do, on one line; the names are pins, the why waits in the Panel.
  assert.match(merge, /data-fix-kind="merge"/);
  assert.match(visibleText(merge), /Merge 2 tools into one/);
  assert.doesNotMatch(visibleText(merge), /precedes/);
  assert.match(merge, /href="\/project\/p1\/improvement\/fixes\?tool=find_task"/);
  assert.match(merge, /href="\/project\/p1\/improvement\/fixes\?tool=assign_task"/);
  // One compact effect, its derivation in the Panel.
  assert.match(visibleText(merge), /2 → 1 calls/);
  assert.doesNotMatch(visibleText(merge), /model calls in all/);
  assert.match(merge, /data-evidence="strong"[^>]*>/);
  assert.match(merge, /class="[^"]*text-success[^"]*"[^>]*data-evidence="strong"/);
  const tighten = rows(tools).find((row) => row.includes('data-fix-kind="schema"'))!;
  assert.match(tighten, /class="[^"]*text-fg-subtle[^"]*"[^>]*data-evidence="early"/);
  const retry = rows(tools).find((row) => row.includes('data-fix-kind="fail-clearly"'))!;
  assert.match(retry, /class="[^"]*text-info[^"]*"[^>]*data-evidence="solid"/);
  // A task pin wears its task's color.
  assert.match(retry, /class="size-2 shrink-0 rounded-\[2px\] bg-chart-4"/);
  assert.match(visibleText(retry), /Not measured/);
  // The rewrite's effect, found in a replay.
  assert.match(visibleText(table(html, "descriptions")), /\+40 pts found/);
});

test("each table has one action, the same on every row", () => {
  const html = page();
  for (const row of rows(table(html, "tools"))) {
    assert.equal(row.match(/>Copy prompt</g)?.length, 1, "Copy prompt on every tool change");
    assert.doesNotMatch(row, />Dismiss</, "Dismiss waits in the Panel");
  }
  assert.equal(
    rows(table(html, "ranking")).every((row) => row.includes(">Copy prompt<")),
    true,
  );
  const descriptions = rows(table(html, "descriptions"));
  // A description is updated on Quality › Descriptions: the rewrite open, else its tool.
  assert.match(
    descriptions[0]!,
    /<a[^>]*href="\/project\/p1\/quality\/descriptions\?peek=rewrite%3Amq-lookup"[^>]*>Update description/,
  );
  assert.match(
    descriptions[1]!,
    /<a[^>]*href="\/project\/p1\/quality\/descriptions\?tool=assign_task"[^>]*>Update description/,
  );
  // Apply lives on Quality, not here.
  assert.doesNotMatch(html, /Apply rewrite|>Revert</);
});

test("applied rewrites are counted beside the descriptions, a link to Quality", () => {
  const html = table(page(), "descriptions");
  assert.match(html, /<a[^>]*href="\/project\/p1\/quality\/descriptions"[^>]*>1 applied/);
});

test("filters from the URL: kind as a menu, tool and intent as chips", () => {
  const rewrites = page({}, "?kind=rewrite");
  assert.match(visibleText(rewrites), /2 of 8 open fixes/);
  assert.match(rewrites, /id="fixes-descriptions"/);
  assert.doesNotMatch(rewrites, /id="fixes-tools"/, "a table with no match is left out");
  const tool = page({}, "?tool=lookup_order");
  assert.match(visibleText(tool), /Tool lookup_order/);
  assert.match(tool, /aria-label="Remove Tool filter"/);
  const intent = page({}, "?topic=t_orders");
  assert.match(visibleText(intent), /Intent Order status/);
  assert.match(intent, /aria-label="Remove Intent filter"/);
  const nothing = visibleText(page({}, "?topic=nowhere"));
  assert.match(nothing, /No fixes match Clear the filters to see every fix\. Clear filters/);
});

test("with nothing to fix, the empty state says what fills it", () => {
  const empty = page({
    open: [],
    applied: [],
    stats: {
      open: 0,
      ready: 0,
      fromIssues: 0,
      issues: 0,
      tools: 0,
      roundTripsSaved: null,
      evidence: { strong: 0, solid: 0, early: 0, none: 0 },
    },
  });
  const text = visibleText(empty);
  assert.match(text, /No fixes yet/);
  assert.match(text, /Fixes appear when Agent health finds an issue with a clear change/);
  assert.match(empty, /<a[^>]*href="\/project\/p1\/health"[^>]*>Open Agent health<\/a>/);
  assert.match(empty, /href="\/project\/p1\/quality"[^>]*>Analyse searches on Quality/);
  assert.doesNotMatch(empty, /Open fixes/, "no row of zeros above an empty state");
});

test("a source that failed is named above the rest", () => {
  const html = page({ failed: ["craft", "issue"] });
  assert.match(html, /role="note"/);
  assert.match(
    visibleText(html),
    /Some fixes couldn't be loaded The changes drafted from your tasks and issues from Agent health didn't load/,
  );
});

test("the panel leads with the kind, the effect as a big figure and the evidence, then the pins", () => {
  const fix = findFix(model.open, "craft:c-merge")!;
  const html = render(
    createElement(FixDetail, { fix, actions: createElement("span", { "data-testid": "actions" }) }),
  );
  const text = visibleText(html);
  assert.match(
    text,
    /^ ?Merge tools Better: 2 → 1 calls −40 model calls in all, over the window · 40 times together Strong Seen 40 times in this window/,
  );
  assert.match(html, /class="text-2xl[^"]*"[^>]*>2 → 1<\/span>/);
  assert.match(html, /data-testid="actions"/);
  // The pins open where each thing lives.
  assert.match(html, /href="\/project\/p1\/catalogs\/tools\?highlight=find_task"/);
  assert.match(html, /href="\/project\/p1\/health\/tasks\/wf_assign"/);
  assert.match(html, /href="\/project\/p1\/intents\?peek=t_handover"/);
  // The drawing of the change stays for drafted kinds; the numbers wait behind Details.
  assert.match(html, /data-kind-motion="merge_tools"/);
  assert.match(text, /Details How it adds up, and the tools today/);
});

test("the panel tells a rewrite with its before and after, its issue, and where to apply it", () => {
  const fix = findFix(model.open, "rewrite:mq-lookup")!;
  const html = render(
    createElement(FixDetail, { fix, actions: createElement("span", { "data-testid": "actions" }) }),
  );
  const text = visibleText(html);
  assert.match(
    text,
    /\+40 pts found 3 → 5 of 5 searches, in a replay of past searches Solid Missed 12 searches · Seen it run/,
  );
  assert.match(
    text,
    /Searchable description Now Look up an order\. After the rewrite Look up an order\. Use for order status, tracking and where is my order\./,
  );
  assert.match(html, /<ins[^>]*>Use for order status, tracking and where is my order\.<\/ins>/);
  // Each issue a compact row: its title, its sentence on one quiet line, and the number Agent health shows.
  assert.match(
    text,
    /The issue it resolves Wrong tool keeps showing up lookup_order rides into 41% of lists and is picked in 1%\. 41% of lists Open in Agent health/,
  );
  assert.match(html, /href="\/project\/p1\/health#signal-i-magnet"/);
  assert.equal(
    fix.actions.descriptionHref,
    "/project/p1/quality/descriptions?peek=rewrite%3Amq-lookup",
  );
});

test("the panel tells a drafted change: what it is worth, why, the change", () => {
  const fix = findFix(model.open, "craft:c-tighten")!;
  const text = visibleText(
    render(createElement(FixDetail, { fix, actions: createElement("span") })),
  );
  assert.match(
    text,
    /−1 failed call −6 model calls in all, over the window · 6 failures Early Seen 6 times in this window/,
  );
  assert.match(text, /The agent's first call to this tool often fails and the retry works/);
  assert.match(
    text,
    /The change [\s\S]*Compare flaky_api's validator with its published input schema/,
  );
  assert.match(text, /Details [\s\S]*Tools today flaky_api/);
});

test("the panel tells an issue's own fix: the issues it resolves as rows, and the change", () => {
  const fix = findFix(model.open, "issue:i-magnet-2")!;
  const html = render(createElement(FixDetail, { fix, actions: createElement("span") }));
  const text = visibleText(html);
  // Not measured: what the issue costs today leads, said as today.
  assert.match(text, /50% of turns Today, before the fix Strong 10 of 20 turns/);
  assert.match(html, /data-today-figure=""/);
  assert.match(
    text,
    /The 2 issues it resolves Wrong tool keeps showing up assign_task rides into 30% of lists and is never picked\. 50% of turns/,
  );
  assert.match(text, /The change Change something\./);
  assert.equal(
    html.match(/href="\/project\/p1\/health#signal-/g)?.length,
    2,
    "each issue opens on Agent health",
  );
});

test("no engine words on the page, and no person's words inside an attribute", () => {
  const html = page();
  assert.doesNotMatch(visibleText(html), FORBIDDEN);
  for (const fix of model.open) {
    const panel = render(createElement(FixDetail, { fix, actions: createElement("span") }));
    const attributes = [
      ...panel.matchAll(/\s(?:title|aria-label|alt|placeholder|data-[\w-]+)="([^"]*)"/g),
    ].map((match) => match[1]);
    for (const value of attributes)
      assert.doesNotMatch(
        value!,
        /where is my order|Order status|Hand a task over/,
        `${fix.id}: ${value}`,
      );
    assert.doesNotMatch(visibleText(panel), FORBIDDEN, fix.id);
  }
  const pageAttributes = [
    ...html.matchAll(/\s(?:title|aria-label|alt|placeholder|data-[\w-]+)="([^"]*)"/g),
  ].map((match) => match[1]);
  for (const value of pageAttributes)
    assert.doesNotMatch(
      value!,
      /where is my order|Order status|Hand a task over|Check an order/,
      value,
    );
});

test("the skeleton holds the page's shape while it loads", () => {
  const html = renderToStaticMarkup(createElement(FixesSkeleton));
  assert.match(html, /role="status" aria-busy="true"/);
  assert.match(html, /Loading fixes…/);
});

test("while nothing fetches the overrides, the descriptions say a rewrite may not reach the agent", () => {
  assert.match(
    table(page({ overridesAdopted: null }), "descriptions"),
    /data-caveat="runtime"[\s\S]*May not reach your agent yet/,
  );
  assert.doesNotMatch(
    page(),
    /data-caveat="runtime"/,
    "a recent fetch is the one state that removes it",
  );
});

test("an applied rewrite reads before and now, and opens on Quality", () => {
  const fix = model.applied[0]!;
  const text = visibleText(
    render(createElement(FixDetail, { fix, actions: createElement("span") })),
  );
  assert.match(text, /Searchable description Before .* Now, applied /);
  assert.equal(
    fix.actions.descriptionHref,
    "/project/p1/quality/descriptions?peek=rewrite%3Amq-notify",
  );
});

test("a fix that resolves many issues lists the worst three and links to the rest", () => {
  const fix = findFix(model.open, "rewrite:mq-lookup")!;
  const many = {
    ...fix,
    issues: ["a", "b", "c", "d", "e"].map((id) => ({
      id,
      kind: "magnet",
      title: `Issue ${id}`,
      claim: `Claim ${id}.`,
      cost: "",
      figure: null,
      href: `/project/p1/health#signal-${id}`,
    })),
  };
  const text = visibleText(
    render(createElement(FixDetail, { fix: many, actions: createElement("span") })),
  );
  assert.match(text, /The 5 issues it resolves/);
  assert.match(text, /Issue c/);
  assert.doesNotMatch(text, /Issue d/);
  assert.match(text, /And 2 more issues in Agent health/);
});
