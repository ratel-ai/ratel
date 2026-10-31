/* eslint-disable react/no-children-prop --
 * The runner only picks up `.ts`, so components are built with createElement,
 * and required `children` props have to be passed in props to typecheck.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DotSpark } from "@ratel/design-system/dot-matrix";
import { createElement } from "react";
import { MissDetail } from "@/components/console/quality/MissesList";
import { MissesView } from "@/components/console/quality/MissesView";
import { HeadlineLine, QualityFrame } from "@/components/console/quality/QualityFrame";
import { QualitySkeleton } from "@/components/console/quality/QualitySkeleton";
import type { EvidenceSourceLabel, Headline } from "./headline";
import { evidence, missRow, missRowsFixture, NOW, ROOT, render, visibleText } from "./test-support";

function frame(pathname: string, search = "") {
  return render(
    createElement(QualityFrame, {
      projectId: "p1",
      tabs: ["misses", "descriptions", "experiments"],
      search,
      meta: { misses: 20, descriptions: 4 },
      headline: createElement(HeadlineLine, {
        headline: evidence().headline,
        source: { kind: "telemetry" },
        windowPhrase: "the last 7 days",
        versusPhrase: "vs the previous 7 days",
      }),
      actions: createElement("span", { "data-testid": "actions" }),
      children: createElement("div", { "data-testid": "body" }),
    }),
    { pathname },
  );
}

function headline(
  overrides: Partial<Headline>,
  source: EvidenceSourceLabel = { kind: "telemetry" },
  cut: number | null = null,
): string {
  return visibleText(
    render(
      createElement(HeadlineLine, {
        headline: { ...evidence().headline, ...overrides },
        source,
        windowPhrase: "the last 7 days",
        versusPhrase: "vs the previous 7 days",
        cut,
      }),
    ),
  );
}

test("one h1, the headline with its tier, change and trend, and the tabs as links", () => {
  const html = frame(`${ROOT}/quality/experiments`, "?range=30d");
  assert.match(html, /<h1[^>]*>Quality<\/h1>/);
  assert.equal(html.match(/<h1/g)?.length, 1);
  assert.match(html, /data-page="v2"/);
  assert.match(html, /data-headline="right-tool-first" data-tier="judged"/);
  assert.match(html, /Right tool first/);
  assert.match(html, />63%</);
  assert.match(html, /\+6 pts<span class="sr-only"> vs the previous 7 days<\/span>/);
  assert.match(
    html,
    /role="img" aria-label="Right tool first per day, the last 7 days\. Blank days had too few searches\."/,
  );
  assert.match(html, /Judged on 140 searches your agent made/, "the number names its tier");
  assert.match(html, /<nav aria-label="Quality sections"/);
  assert.match(
    html,
    /<a(?=[^>]*href="\/project\/p1\/quality\?range=30d")(?![^>]*aria-current)[^>]*>Misses<span[^>]*>20<\/span>/,
  );
  assert.match(
    html,
    /<a(?=[^>]*href="\/project\/p1\/quality\/descriptions\?range=30d")(?![^>]*aria-current)[^>]*>Descriptions<span[^>]*>4<\/span>/,
  );
  assert.match(
    html,
    /<a(?=[^>]*href="\/project\/p1\/quality\/experiments\?range=30d")(?=[^>]*aria-current="page")[^>]*>Experiments/,
    "a tab carrying the window is still the current one",
  );
  assert.match(html, /data-testid="actions"/);
  assert.match(html, /data-testid="body"/);
});

test("without judged searches there is no number, only the next step", () => {
  const none = headline({ tier: null, n: 0, hits: 0, share: null, change: null, trend: [] });
  assert.match(none, /Right tool first Not measured yet/);
  assert.match(none, /No judged searches in the last 7 days\. Analyse searches to judge them\./);
  assert.doesNotMatch(none, /%/);
  const thin = headline({ tier: "judged", n: 4, hits: 3, share: null, change: null });
  assert.match(thin, /Not enough searches yet/);
  assert.match(thin, /Judged: 4 searches in the last 7 days, 10 needed/);
  assert.doesNotMatch(thin, /%/);
});

test("the headline names an experiment's variant, the seen tier, and a cut read", () => {
  const seen = headline(
    { tier: "seen", n: 40, hits: 30, share: 0.75, change: null },
    {
      kind: "experiment",
      name: "reranker-shadow",
      variant: "shadow",
    },
  );
  assert.match(seen, /75%/);
  assert.match(seen, /Seen it run on 40 searches in reranker-shadow, variant shadow/);
  assert.match(
    headline({}, { kind: "telemetry" }, 5000),
    /your agent made, from the newest 5,000 in this window/,
  );
});

test("a trend tells a thin day from a real 0%", () => {
  const html = render(
    createElement(DotSpark, { values: [0.5, null, 0, 0.6], label: "Right tool first per day" }),
  );
  assert.equal(html.match(/data-gap=""/g)?.length, 1, "only the thin day is a gap");
  const zero = html.split('aria-hidden="true"').filter((part) => part.includes("flex-col-reverse"));
  assert.equal(zero.length, 3, "the 0% day keeps its unlit column");
});

function misses(props: Partial<Parameters<typeof MissesView>[0]> = {}) {
  return render(
    createElement(MissesView, {
      projectId: "p1",
      evidence: evidence(),
      rows: missRowsFixture(),
      locked: false,
      billingHref: "/org/acme/billing",
      windowPhrase: "the last 7 days",
      wider: { href: `${ROOT}/quality?range=30d`, label: "Last 30 days" },
      analyse: createElement("button", { "data-testid": "analyse" }, "Analyse searches"),
      now: NOW,
      ...props,
    }),
  );
}

test("the list: each miss with its right tool as a pin, where it landed in color, and what came first", () => {
  const html = misses();
  assert.match(html, /data-tab="misses"/);
  assert.match(
    html,
    /<caption class="sr-only">Searches where the right tool was not ranked first<\/caption>/,
  );
  assert.match(html, /role="toolbar" aria-label="Filters"/);
  assert.match(html, /<input type="search" aria-label="Search misses"/);
  assert.match(html, /2 misses/);
  assert.equal(html.match(/<tr tabindex=/g)?.length, 2);
  assert.match(html, /deploy to staging/);
  // Tools are pins: a wrench mark beside a mono name, never bare text.
  assert.match(
    html,
    /<span class="[^"]*font-mono[^"]*"><svg[^>]*lucide-wrench[\s\S]*?vercel_promote_deployment/,
  );
  assert.match(
    html,
    /<span class="[^"]*font-mono[^"]*"><svg[^>]*lucide-wrench[\s\S]*?flaky_deploy_api/,
  );
  // Outcomes in color, each with an icon and a word.
  assert.match(
    html,
    /bg-warning-subtle[^"]*"><svg[^>]*lucide-arrow-down[\s\S]*?data-outcome="lower">Ranked 4th</,
  );
  assert.match(
    html,
    /bg-danger-subtle[^"]*"><svg[^>]*lucide-circle-x[\s\S]*?data-outcome="missing">Not returned</,
  );
  // How we know lives in the Panel now, not in the table.
  assert.doesNotMatch(html, /How we know|>Seen it run<|>Judged</);
  assert.match(html, /<time dateTime="2026-10-15T03:00:00.000Z"/);
  assert.doesNotMatch(
    visibleText(html),
    /\u2014|BM25|Jev|nDCG|shadow|judge model|suggestion|topic|signal/i,
  );
});

test("the outcome filter counts each kind and narrows the list in the URL", () => {
  const html = misses();
  assert.match(html, /role="group" aria-label="Outcome"/);
  assert.match(visibleText(html), /All Not returned 1 Ranked lower 1/);
  const missing = render(
    createElement(MissesView, {
      projectId: "p1",
      evidence: evidence(),
      rows: missRowsFixture(),
      locked: false,
      billingHref: null,
      windowPhrase: "the last 7 days",
      wider: null,
      now: NOW,
    }),
    { search: "?outcome=missing" },
  );
  assert.equal(missing.match(/<tr tabindex=/g)?.length, 1);
  assert.match(missing, /1 of 2 misses/);
  assert.doesNotMatch(missing, /deploy to staging/);
});

test("a person's words never sit in an attribute", () => {
  const html = misses();
  const attributes = [
    ...html.matchAll(/\s(?:title|aria-label|alt|placeholder|href|data-[\w-]+)="([^"]*)"/g),
  ].map((match) => match[1]);
  for (const value of attributes) {
    assert.doesNotMatch(value!, /deploy to staging|create a task/, value);
  }
});

test("the open row follows ?peek=, by its own id or a sighting folded into it", () => {
  const open = render(
    createElement(MissesView, {
      projectId: "p1",
      evidence: evidence(),
      rows: missRowsFixture(),
      locked: false,
      billingHref: null,
      windowPhrase: "the last 7 days",
      wider: null,
      now: NOW,
    }),
    { search: "?peek=sel-old" },
  );
  assert.match(open, /<tr[^>]*aria-current="true"[^>]*data-selected="true"/);
  assert.equal(open.match(/data-selected="true"/g)?.length, 1);
  const filtered = render(
    createElement(MissesView, {
      projectId: "p1",
      evidence: evidence(),
      rows: missRowsFixture(),
      locked: false,
      billingHref: null,
      windowPhrase: "the last 7 days",
      wider: null,
      now: NOW,
    }),
    { search: "?q=task" },
  );
  assert.match(filtered, /value="task"/);
  assert.equal(
    filtered.match(/<tr tabindex=/g)?.length,
    1,
    "the filter in the URL narrows the list",
  );
  assert.match(filtered, /1 of 2 misses/);
});

test("every state sits where the list would be", () => {
  assert.match(
    misses({ locked: true }),
    /data-state="upgrade"[\s\S]*Misses and rewrites are part of Pro[\s\S]*href="\/org\/acme\/billing"/,
  );
  assert.match(
    misses({ locked: true, billingHref: null }),
    /Ask your Ratel contact to turn on Pro\./,
  );
  assert.match(
    misses({ evidence: null }),
    /role="alert"[\s\S]*Couldn&#x27;t load misses[\s\S]*Try again/,
  );
  const none = misses({ evidence: evidence({ searches: 0, answered: 0, missCount: 0 }), rows: [] });
  assert.match(none, /No searches in the last 7 days/);
  assert.match(none, /<a[^>]*href="\/project\/p1\/quality\?range=30d"[^>]*>Last 30 days<\/a>/);
  const unanswered = misses({ evidence: evidence({ answered: 0, missCount: 0 }), rows: [] });
  assert.match(unanswered, /No search has a known right tool yet/);
  assert.match(unanswered, /each of your 312 searches needed/);
  assert.match(unanswered, /data-testid="analyse"/);
  const clean = misses({ evidence: evidence({ missCount: 0 }), rows: [] });
  assert.match(clean, /The right tool came first every time/);
  assert.match(clean, /Across 281 searches with a known right tool in the last 7 days\./);
});

test("the panel body: the right tool and its outcome, how we know, the ranking, and where to go next", () => {
  const html = render(
    createElement(MissDetail, {
      projectId: "p1",
      row: missRow({ traceHref: `${ROOT}/traces/abc` }),
    }),
  );
  const text = visibleText(html);
  assert.match(text, /Right tool vercel_promote_deployment Ranked 4th/);
  assert.match(text, /How we know Seen it run Your agent ran this tool for this ask\./);
  assert.match(html, /What your agent saw/);
  assert.equal(html.match(/<li data-rank=/g)?.length, 4);
  assert.match(
    html,
    /<li data-rank="4" data-right-tool="true" data-outcome="lower" class="[^"]*bg-warning-subtle[\s\S]*vercel_promote_deployment[\s\S]*Right tool/,
  );
  // A plain recorded search opens the Playground on click; its words are not in the markup's attributes.
  assert.match(html, /<button type="button"[^>]*>[\s\S]*Test this search<\/button>/);
  assert.doesNotMatch(html, /href="[^"]*[?&;]q=/, "no ask in any link");
  assert.match(html, /<a[^>]*href="\/project\/p1\/traces\/abc"[^>]*>[\s\S]*Open trace<\/a>/);
  assert.match(
    html,
    /<a(?=[^>]*href="\/project\/p1\/quality\/descriptions\?tool=vercel_promote_deployment")(?=[^>]*data-rewrite="none")[^>]*>[\s\S]*See its description<\/a>/,
  );

  const missing = render(
    createElement(MissDetail, {
      projectId: "p1",
      row: missRow({
        rank: null,
        evidence: "judged",
        traceHref: null,
        test: { kind: "selection", selectionId: "sel-9", experimentName: "tool-search" },
        rewrite: "pending",
        comparison: {
          arm: "legacy",
          served: true,
          items: [{ id: "vercel_promote_deployment", name: "vercel_promote_deployment" }],
          more: 0,
        },
        comparisonRank: 1,
        ours: {
          ...missRow().ours,
          served: false,
          items: missRow().ours.items.slice(0, 3),
          more: 7,
        },
      }),
    }),
  );
  assert.match(
    missing,
    /data-outcome="missing"[\s\S]*Not returned[\s\S]*vercel_promote_deployment/,
  );
  assert.match(
    visibleText(missing),
    /A model read the ask against your catalog and named this tool\./,
  );
  assert.match(missing, /Ranked by ratel[\s\S]*Ranked by legacy[\s\S]*Shown to your agent/);
  assert.match(
    missing,
    /<li data-rank="1" data-right-tool="true" data-outcome="first" class="[^"]*bg-success-subtle/,
    "the other variant had it first",
  );
  // An experiment's search reopens by its ids alone.
  assert.match(
    missing,
    /<a[^>]*href="\/project\/p1\/playground\?selection=sel-9&amp;experiment=tool-search"[^>]*>[\s\S]*Test this search<\/a>/,
  );
  assert.match(missing, /data-rewrite="pending"[^>]*>[\s\S]*Review its rewrite<\/a>/);
  assert.doesNotMatch(missing, /Open trace/);
});

test("the loading skeleton mirrors the page and announces itself", () => {
  const html = render(createElement(QualitySkeleton));
  assert.match(html, /role="status" aria-busy="true"/);
  assert.match(html, /Loading quality…/);
  assert.match(html, /data-page="v2"/);
});
