import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CapabilityDetails,
  type PanelSearch,
} from "@/components/console/playground/CapabilityPanel";
import { ResultSection, type ResultView } from "@/components/console/playground/ResultSection";
import { CATALOG_DESCRIPTIONS } from "@/lib/ingest/catalogs/vocabulary";
import type { BenchEntry, BenchSaveAffordance } from "@/lib/synthesis/playground/bench-view";
import {
  type ComparisonColumn,
  comparisonColumns,
} from "@/lib/synthesis/playground/calibration-compare";
import { askTerms } from "@/lib/synthesis/playground/matched-words";
import { type ResultList, resultList } from "@/lib/synthesis/playground/result-view";
import type { PlaygroundRun } from "@/lib/synthesis/playground/run";
import { BENCH_ENTRY_DEFAULTS, RANKED_HIT_DEFAULTS } from "@/lib/synthesis/playground/test-support";
import type { RankedHit } from "@/lib/synthesis/playground/types";

/**
 * What Test a search SAYS: which description a search reads and which one the
 * agent gets, why a result placed where it did, and which of the actions
 * writes anything. The words are the feature here, so they are pinned.
 */

const noop = () => undefined;

function entry(over: Partial<BenchEntry> & { id: string }): BenchEntry {
  return {
    ...BENCH_ENTRY_DEFAULTS,
    kind: "tool",
    description: "Books a seat on a flight.",
    edited: false,
    rank: null,
    calls: null,
    hasDefinition: true,
    status: null,
    ...over,
  };
}

function details(
  row: BenchEntry,
  over: { search?: PanelSearch | null; saveAffordance?: BenchSaveAffordance } = {},
): string {
  return renderToStaticMarkup(
    createElement(CapabilityDetails, {
      entry: row,
      savedDescription: "Old words.",
      savedTags: null,
      search: over.search ?? null,
      saveAffordance: over.saveAffordance ?? { kind: "searchable-description", label: "Save" },
      saving: false,
      onTest: noop,
      onDiscard: noop,
      onSave: noop,
    }),
  );
}

test("the field is named with the decided vocabulary", () => {
  const html = details(entry({ id: "book_flight" }));
  assert.match(html, new RegExp(CATALOG_DESCRIPTIONS.searchable.label));
});

test("the agent description shows, labelled, only when it differs", () => {
  const same = details(entry({ id: "book_flight", agentDescription: null }));
  assert.doesNotMatch(same, new RegExp(CATALOG_DESCRIPTIONS.agent.label));
  const split = details(entry({ id: "book_flight", agentDescription: "Use for flights only." }));
  assert.match(split, new RegExp(CATALOG_DESCRIPTIONS.agent.label));
  assert.match(split, /Use for flights only\./);
});

test("testing and saving are two different verbs, and only a tested change can be saved", () => {
  const fresh = details(entry({ id: "book_flight" }));
  assert.match(fresh, /Keep for the next search/);
  assert.doesNotMatch(fresh, /Save to catalog/);
  const changed = details(entry({ id: "book_flight", edited: true }));
  assert.match(changed, /Save to catalog/);
  assert.match(changed, /Undo my change/);
  assert.match(changed, /Saved description/);
});

test("a change Ratel cannot write says why instead of offering a dead button", () => {
  const html = details(entry({ id: "book_flight", edited: true }), {
    saveAffordance: { kind: "blocked", reason: "Test only. Register this tool to save." },
  });
  assert.doesNotMatch(html, /Save to catalog/);
  assert.match(html, /Test only\. Register this tool to save\./);
});

const searchFor = (query: string, mode: PanelSearch["mode"] = "bm25"): PanelSearch => ({
  query,
  mode,
  top: 5,
  row: null,
});

test("why it placed: the shared words, or plainly that there are none", () => {
  const shared = details(entry({ id: "book_flight" }), {
    search: searchFor("book flights to Lisbon"),
  });
  assert.match(shared, /<mark[^>]*>book<\/mark>/);
  assert.match(shared, /<mark[^>]*>flights<\/mark>/);
  assert.doesNotMatch(shared, /No words in common/);
  const none = details(entry({ id: "book_flight" }), { search: searchFor("weather in Porto") });
  assert.match(none, /No words in common, so a keyword search can(&#x27;|')t find it/);
  const meaning = details(entry({ id: "book_flight" }), {
    search: searchFor("weather in Porto", "embeddings"),
  });
  assert.match(meaning, /matched on meaning/);
});

const hit = (id: string, score: number, description: string): RankedHit => ({
  ...RANKED_HIT_DEFAULTS,
  id,
  kind: "tool",
  rank: 0,
  score,
  bm25Score: null,
  embeddingScore: null,
  description,
  searchableDescription: description,
  edited: false,
});

function section(
  list: ResultList,
  emptyReason: string | null = null,
  compare: { columns: ComparisonColumn[]; view: ResultView; expected?: string } | null = null,
): string {
  return renderToStaticMarkup(
    createElement(ResultSection, {
      list,
      catalogSize: 94,
      terms: askTerms("book a flight"),
      verdict: { tone: "neutral", text: "Your agent would pick get_weather first." },
      changes: [],
      emptyReason,
      expected: compare?.expected ?? null,
      onExpect: noop,
      catalogItems: [],
      onOpen: noop,
      openId: null,
      compare: compare?.columns ?? null,
      view: compare?.view ?? "list",
      onViewChange: noop,
    }),
  );
}

test("a result row shows its description with the ask's words lit", () => {
  const run = {
    baseline: {
      skills: [],
      tools: [
        hit("get_weather", 4, "Weather for a city."),
        hit("book_flight", 3, "Books a flight."),
      ],
    },
    hasEdits: false,
  } as unknown as PlaygroundRun;
  const html = section(resultList(run, "tool"));
  assert.match(html, /Top 2 of 94/);
  assert.match(html, /<mark[^>]*>flight<\/mark>/);
  assert.match(html, /Your agent would pick get_weather first\./);
});

test("an empty result says why in place of the list", () => {
  const run = { baseline: { skills: [], tools: [] }, hasEdits: false } as unknown as PlaygroundRun;
  const html = section(
    resultList(run, "tool"),
    "No tool shares a word with this ask. Try other words.",
  );
  assert.match(html, /No tool shares a word with this ask\./);
  assert.doesNotMatch(html, /<ol/);
});

const savedAndChanged = {
  baseline: {
    skills: [],
    tools: [
      hit("get_weather", 4, "Weather."),
      hit("tier", 3.6, "Tier."),
      hit("book_flight", 3.4, "Books a flight."),
    ],
  },
  drafted: {
    skills: [],
    tools: [
      hit("book_flight", 6, "Book a flight."),
      hit("get_weather", 4, "Weather."),
      hit("tier", 3.6, "Tier."),
    ],
  },
  hasEdits: true,
} as unknown as PlaygroundRun;
const kinds = new Map([
  ["get_weather", "tool"],
  ["tier", "tool"],
  ["book_flight", "tool"],
  ["change_flight", "tool"],
] as const);

test("Compare holds Before and After side by side, each row's move named against the column before", () => {
  const columns = comparisonColumns({
    arms: [],
    saved: savedAndChanged.baseline,
    edited: savedAndChanged.drafted,
    kind: "tool",
    kindById: kinds,
  });
  const html = section(resultList(savedAndChanged, "tool"), null, {
    columns,
    view: "compare",
    expected: "book_flight",
  });
  assert.match(html, />Before</);
  assert.match(html, />After</);
  assert.match(html, /up 2/);
  assert.match(html, /down 1/);
  // The switch is there to go back to the list.
  assert.match(html, />List</);
  assert.match(html, />Compare</);
  // The expected tool is marked in every column it appears in.
  assert.equal(html.match(/border-l-(success|warning)/g)?.length, 2);
  assert.doesNotMatch(html, /Recorded/);
});

test("from an experiment, the variants come first under Recorded, then today under Live", () => {
  const columns = comparisonColumns({
    arms: [
      { arm: "a", role: "served", resultIds: ["change_flight", "book_flight"] },
      { arm: "b", role: "shadow", resultIds: ["book_flight", "get_weather"] },
    ],
    saved: savedAndChanged.baseline,
    edited: null,
    kind: "tool",
    kindById: kinds,
  });
  const html = section(
    resultList({ ...savedAndChanged, hasEdits: false } as PlaygroundRun, "tool"),
    null,
    {
      columns,
      view: "compare",
    },
  );
  assert.match(html, /Recorded/);
  assert.match(html, /Live/);
  assert.match(html, />Current variant</);
  assert.match(html, />Comparison variant</);
  // With nothing after it, the saved column is today, not "before".
  assert.match(html, />Today</);
  assert.doesNotMatch(html, />Before</);
});

test("with nothing to compare there is no switch, just the list", () => {
  const html = section(
    resultList({ ...savedAndChanged, hasEdits: false } as PlaygroundRun, "tool"),
  );
  assert.doesNotMatch(html, />Compare</);
});
