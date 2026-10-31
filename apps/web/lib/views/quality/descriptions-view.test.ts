import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { DescriptionsView } from "@/components/console/quality/DescriptionsView";
import { FoundMeter } from "@/components/console/quality/FoundMeter";
import { MissedSearchesList, RewriteDetail } from "@/components/console/quality/RewriteDetail";
import { ToolCardDetail } from "@/components/console/quality/ToolCardDetail";
import type { RewriteRow, ToolCard } from "./descriptions";
import type { DescriptionsData } from "./load-descriptions";
import { evidence, NOW, ROOT, render, visibleText } from "./test-support";

/** Words the console never says (DESIGN.md, the product's nouns and the Glossary). */
const FORBIDDEN =
  /\u2014|suggestion|topic|signal|workflow|tool craft|BM25|Jev|nDCG|judge model|shadow|backtest/i;

function rewrite(overrides: Partial<RewriteRow> = {}): RewriteRow {
  return {
    id: "r-schedule",
    peek: "rewrite:r-schedule",
    status: "pending",
    toolId: "get_project_schedule",
    toolName: "get_project_schedule",
    missed: 57,
    change: "adds",
    effect: { delta: "+46 pts", direction: "up", tool: { n: 20, before: 10, after: 19 } },
    createdAt: "2026-10-21T01:12:00.000Z",
    appliedAt: null,
    before: "Read a project's schedule.",
    after: "Read a project's schedule. Use to answer whether an activity is on track or behind.",
    spans: [
      { op: "same", text: "Read a project's schedule. " },
      { op: "added", text: "Use to answer whether an activity is on track or behind." },
    ],
    rationale: "Added the on-track wording people type.",
    ...overrides,
  };
}

function data(overrides: Partial<DescriptionsData> = {}): DescriptionsData {
  return {
    pending: [
      rewrite(),
      rewrite({
        id: "r-notify",
        peek: "rewrite:r-notify",
        toolId: "notify_team",
        toolName: "notify_team",
        missed: 5,
        effect: null,
      }),
    ],
    applied: [
      rewrite({
        id: "r-co",
        peek: "rewrite:r-co",
        status: "applied",
        toolId: "estimate_change_order",
        toolName: "estimate_change_order",
        appliedAt: "2026-10-08T03:09:00.000Z",
        effect: { delta: "+9 pts", direction: "up", tool: { n: 12, before: 10, after: 11 } },
      }),
    ],
    projection: { pending: 2, delta: "+16 pts", direction: "up", significant: true, replayed: 840 },
    run: { phase: "analyzed", declinedReason: null },
    overridesAdopted: null,
    experimentName: "tool-search",
    tool: null,
    ...overrides,
  };
}

function view(props: Partial<Parameters<typeof DescriptionsView>[0]> = {}, search = "") {
  return render(
    createElement(DescriptionsView, {
      projectId: "p1",
      evidence: evidence(),
      data: data(),
      locked: false,
      billingHref: "/org/acme/billing",
      analyse: createElement("button", { "data-testid": "analyse" }, "Analyse searches"),
      windowPhrase: "the last 7 days",
      versusPhrase: "vs the previous 7 days",
      now: NOW,
      ...props,
    }),
    { pathname: `${ROOT}/quality/descriptions`, search },
  );
}

test("the score: how often the right tool is found, its trend, and what applying every rewrite does", () => {
  const html = view();
  const text = visibleText(html);
  assert.match(html, /data-tab="descriptions"/);
  assert.match(html, /data-score="found"/);
  assert.match(text, /Right tool found 80%/);
  assert.match(html, /\+3 pts<span class="sr-only"> vs the previous 7 days<\/span>/);
  assert.match(text, /Judged on 140 searches/);
  assert.match(
    html,
    /role="img" aria-label="Right tool found per day, the last 7 days\. Blank days had too few searches\."/,
  );
  assert.match(text, /If you apply all 2 \+16 pts Found in a replay of past searches/);
  assert.doesNotMatch(text, /Your own ranking/, "no experiment, no comparison");
});

test("the customer's own ranking beside ours, measured on the same searches", () => {
  const theirs = {
    arm: "legacy",
    served: true,
    first: { ...evidence().headline, share: 0.43 },
    found: { ...evidence().found, share: 0.7 },
  };
  const html = view({ evidence: evidence({ theirs }) });
  const text = visibleText(html);
  assert.match(text, /Your own ranking 70% First 43%/);
  assert.doesNotMatch(text, /legacy/, "the variant's key stays off the page");
  assert.match(html, /data-compare="found"/);
  assert.match(html, /role="meter" aria-label="Ratel: right tool found 80%"/);
  assert.match(html, /role="meter" aria-label="Yours: right tool found 70%"/);
});

test("rewrites to review and applied: a tool pin, the misses in red, the replay in pixels and the actions", () => {
  const html = view();
  const text = visibleText(html);
  assert.match(html, /<h2[^>]*>To review \(2\)<\/h2>/);
  assert.match(html, /<caption class="sr-only">Rewrites to review<\/caption>/);
  assert.match(
    html,
    /<span class="[^"]*font-mono[^"]*"><svg[^>]*lucide-wrench[\s\S]*?get_project_schedule/,
  );
  assert.match(html, /lucide-search-x[^"]*text-danger[\s\S]*?<\/svg>57<\/span>/);
  assert.match(
    html,
    /role="img" aria-label="Found in 19 of 20 past searches with the rewrite, 10 without it"/,
  );
  const meter = html.slice(html.indexOf('aria-label="Found in 19 of 20'), html.indexOf("+46 pts"));
  assert.equal(
    meter.match(/data-cell="gained"/g)?.length,
    9,
    "nine searches the rewrite adds, in green",
  );
  assert.match(text, /\+46 pts/);
  assert.match(text, /Not replayed/, "a rewrite without a replay says so");
  assert.equal(html.match(/>Apply rewrite</g)?.length, 2);
  assert.equal(html.match(/>Dismiss</g)?.length, 2);
  assert.match(html, />Apply all 2</);
  assert.match(html, /<h2[^>]*>Applied \(1\)<\/h2>/);
  assert.match(html, /<time dateTime="2026-10-08T03:09:00.000Z"/);
  assert.equal(html.match(/>Revert</g)?.length, 1);
  assert.match(html, /data-caveat="runtime"[\s\S]*May not reach your agent yet/);
  assert.doesNotMatch(
    view({ data: data({ overridesAdopted: true }) }),
    /data-caveat="runtime"/,
    "a recent fetch removes it",
  );
  assert.doesNotMatch(text, FORBIDDEN);
});

test("?peek= and ?tool= select the row they open", () => {
  assert.match(
    view({}, "?peek=rewrite%3Ar-notify"),
    /<tr[^>]*aria-current="true"[^>]*data-selected="true"[^>]*>[\s\S]*?notify_team/,
  );
  assert.match(
    view({}, "?tool=get_project_schedule"),
    /<tr[^>]*aria-current="true"[^>]*data-selected="true"[^>]*>[\s\S]*?get_project_schedule/,
  );
  assert.doesNotMatch(
    view({}, "?tool=search_spec_book"),
    /data-selected="true"/,
    "a tool without a rewrite opens its card, not a row",
  );
});

test("every state sits where the list would be", () => {
  assert.match(view({ locked: true }), /data-state="upgrade"[\s\S]*part of Pro/);
  assert.match(view({ data: null }), /role="alert"[\s\S]*Couldn&#x27;t load rewrites/);
  assert.match(view({ evidence: null }), /role="alert"[\s\S]*Couldn&#x27;t load the score/);
  const first = view({ data: data({ pending: [], applied: [], run: null, projection: null }) });
  assert.match(first, /No rewrites yet/);
  assert.match(first, /data-testid="analyse"/);
  const live = view({
    data: data({
      pending: [],
      applied: [],
      run: { phase: "running", declinedReason: null },
      projection: null,
    }),
  });
  assert.match(live, /Analysing your searches/);
  assert.doesNotMatch(live, /data-testid="analyse"/, "no second run while one is live");
  const declined = view({
    data: data({
      pending: [],
      applied: [],
      projection: null,
      run: {
        phase: "analyzed",
        declinedReason: "Every tool the agents searched for was already found.",
      },
    }),
  });
  assert.match(
    declined,
    /No rewrites to review[\s\S]*Every tool the agents searched for was already found\./,
  );
  const failed = view({ data: data({ run: { phase: "failed", declinedReason: null } }) });
  assert.match(failed, /role="alert"[\s\S]*The last analysis didn&#x27;t finish/);
  assert.match(failed, /To review \(2\)/, "earlier rewrites stay actionable");
  const reviewed = view({ data: data({ pending: [], projection: null }) });
  assert.doesNotMatch(reviewed, /To review/);
  assert.match(reviewed, /Applied \(1\)/);
});

test("the rewrite panel: what the replay finds, the description now and rewritten, and the actions", () => {
  const html = render(
    createElement(RewriteDetail, {
      projectId: "p1",
      row: rewrite(),
      experimentName: "tool-search",
      catalogHref: "/project/p1/catalogs/tools?highlight=get_project_schedule",
      actions: createElement("span", { "data-testid": "actions" }),
      caveat:
        "Nothing has fetched this project's Cloud overrides recently, so an applied rewrite may not reach your agent yet.",
    }),
  );
  const text = visibleText(html);
  assert.match(text, /Found in a replay of past searches 19 of 20 \+46 pts was 10/);
  assert.match(
    html,
    /<p[^>]*data-before="true"[^>]*><span>Read a project&#x27;s schedule\. <\/span><\/p>/,
  );
  assert.match(
    html,
    /<p[^>]*data-after="true"[^>]*>[\s\S]*<ins[^>]*>Use to answer whether an activity is on track or behind\.<\/ins>/,
  );
  assert.match(html, /aria-label="Copy the new description"/);
  assert.match(text, /Added the on-track wording people type\./);
  assert.match(html, /aria-busy="true"/, "the searches it missed are read when the panel opens");
  assert.match(
    html,
    /<a[^>]*href="\/project\/p1\/catalogs\/tools\?highlight=get_project_schedule"[^>]*>[\s\S]*Edit in Catalog<\/a>/,
  );
  assert.match(html, /data-caveat="runtime"[^>]*>[\s\S]*may not reach your agent yet\./);
  assert.match(html, /data-testid="actions"/);
  assert.doesNotMatch(text, FORBIDDEN);
  const unplayed = visibleText(
    render(
      createElement(RewriteDetail, {
        projectId: "p1",
        row: rewrite({ effect: null }),
        experimentName: null,
        catalogHref: "/c",
        actions: null,
      }),
    ),
  );
  assert.match(unplayed, /Not replayed yet\./);
});

test("the searches a rewrite missed: by ids for an experiment, on click for a plain search, never in an attribute", () => {
  const ready = render(
    createElement(MissedSearchesList, {
      projectId: "p1",
      experimentName: "tool-search",
      state: {
        status: "ready",
        searches: [
          { query: "is the deck pour on track", selectionId: "sel-1" },
          { query: null, selectionId: null },
        ],
        more: 12,
      },
    }),
  );
  assert.match(ready, /is the deck pour on track/);
  assert.match(ready, /Query not recorded/);
  assert.match(
    ready,
    /<a(?=[^>]*aria-label="Test this search")(?=[^>]*href="\/project\/p1\/playground\?selection=sel-1&amp;experiment=tool-search")/,
  );
  assert.match(ready, /And 12 more searches/);
  const telemetry = render(
    createElement(MissedSearchesList, {
      projectId: "p1",
      experimentName: null,
      state: {
        status: "ready",
        searches: [{ query: "is the deck pour on track", selectionId: "evt-1" }],
        more: 0,
      },
    }),
  );
  assert.match(telemetry, /<button type="button" aria-label="Test this search"/);
  for (const html of [ready, telemetry]) {
    const attributes = [
      ...html.matchAll(/\s(?:title|aria-label|alt|placeholder|href|data-[\w-]+)="([^"]*)"/g),
    ].map((match) => match[1]);
    for (const value of attributes) assert.doesNotMatch(value!, /deck pour/, value);
  }
  assert.match(
    render(
      createElement(MissedSearchesList, {
        projectId: "p1",
        experimentName: null,
        state: { status: "failed", message: "Couldn't load the searches." },
      }),
    ),
    /role="alert"[^>]*>Couldn&#x27;t load the searches\./,
  );
  assert.match(
    render(
      createElement(MissedSearchesList, {
        projectId: "p1",
        experimentName: null,
        state: { status: "ready", searches: [], more: 0 },
      }),
    ),
    /No search with its words recorded\./,
  );
});

test("a tool without a rewrite: no rewrite yet, its description, its searches, and Catalog", () => {
  const card: ToolCard = {
    id: "search_spec_book",
    name: "search_spec_book",
    description: "Search a project's specification book for a requirement.",
    source: "Same as the agent description",
    tally: { searches: 12, first: 7, found: 10 },
    catalogHref: "/project/p1/catalogs/tools?highlight=search_spec_book",
  };
  const html = render(createElement(ToolCardDetail, { card, windowPhrase: "the last 7 days" }));
  const text = visibleText(html);
  assert.match(html, /data-state="no-rewrite"/);
  assert.match(text, /No rewrite yet/);
  assert.match(
    text,
    /Searchable description Same as the agent description Search a project&#x27;s specification book|Searchable description Same as the agent description Search a project's specification book/,
  );
  assert.match(text, /Searches 12 First 58% Found 83%/);
  assert.match(html, /role="meter" aria-label="Found in 10 of 12 searches in the last 7 days"/);
  assert.match(
    html,
    /<a[^>]*href="\/project\/p1\/catalogs\/tools\?highlight=search_spec_book"[^>]*>[\s\S]*Edit in Catalog<\/a>/,
  );
  const unknown = visibleText(
    render(
      createElement(ToolCardDetail, {
        card: { ...card, description: null, source: null, tally: null },
        windowPhrase: "the last 7 days",
      }),
    ),
  );
  assert.match(unknown, /Not in your catalog yet\./);
  assert.doesNotMatch(unknown, /Searches where it was the right tool/);
});

test("the replay meter: kept, gained, lost and missed, scaled to twenty pixels", () => {
  const grown = render(createElement(FoundMeter, { n: 5, before: 3, after: 5, label: "x" }));
  assert.equal(grown.match(/data-cell="kept"/g)?.length, 3);
  assert.equal(grown.match(/data-cell="gained"/g)?.length, 2);
  const lost = render(createElement(FoundMeter, { n: 10, before: 6, after: 4, label: "x" }));
  assert.equal(lost.match(/data-cell="lost"/g)?.length, 2);
  assert.equal(lost.match(/data-cell="missed"/g)?.length, 4);
  const many = render(createElement(FoundMeter, { n: 183, before: 95, after: 179, label: "x" }));
  assert.equal(many.match(/data-cell=/g)?.length, 20);
  assert.equal(render(createElement(FoundMeter, { n: 0, before: 0, after: 0, label: "x" })), "");
});
