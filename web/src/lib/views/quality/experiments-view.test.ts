import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { DisagreementDetail } from "@/components/console/quality/DisagreementsList";
import { ExperimentsView } from "@/components/console/quality/ExperimentsView";
import type { DisagreementRow, ExperimentKpis, ExperimentRow } from "./experiments";
import type { ExperimentsData } from "./load-experiments";
import { NOW, ROOT, render, visibleText } from "./test-support";

const KPIS: ExperimentKpis = {
  firstPick: 0.73,
  sameOrder: 0.68,
  coverage: 0.82,
  comparisons: 40,
  disagreements: 13,
  current: "control",
  comparison: "shadow",
};

const RANKING: ExperimentRow = {
  name: "reranker-shadow",
  kind: "ranking",
  comparisons: 40,
  runs: 12,
  kpis: KPIS,
  lastSeen: "2026-09-14T20:48:36.000Z",
};

const GENERIC: ExperimentRow = {
  name: "retrieval-v2",
  kind: "other",
  comparisons: 0,
  runs: 36,
  kpis: null,
  lastSeen: "2026-09-14T09:52:00.000Z",
};

function disagreement(overrides: Partial<DisagreementRow> = {}): DisagreementRow {
  return {
    id: "sel-1",
    query: "check my diff for risky changes",
    occurredAt: "2026-09-13T15:14:13.332Z",
    kind: "first-pick",
    agreement: 0.5,
    current: {
      arm: "control",
      items: [
        { id: "review_pr", name: "review_pr", otherRank: 2, mark: "moved" },
        { id: "github_api", name: "github_api", otherRank: null, mark: "only" },
      ],
    },
    comparison: {
      arm: "shadow",
      items: [{ id: "test_runner", name: "test_runner", otherRank: null, mark: "only" }],
    },
    traceHref: `${ROOT}/traces/abc`,
    test: { kind: "selection", selectionId: "sel-1", experimentName: "reranker-shadow" },
    ...overrides,
  };
}

function data(overrides: Partial<ExperimentsData> = {}): ExperimentsData {
  return {
    rows: [RANKING, GENERIC],
    selected: {
      row: RANKING,
      kpis: KPIS,
      disagreements: [disagreement()],
      detailHref: `${ROOT}/calibration/e~reranker-shadow?range=3m`,
    },
    detailHrefs: {},
    ...overrides,
  };
}

function view(props: Partial<Parameters<typeof ExperimentsView>[0]> = {}) {
  return render(
    createElement(ExperimentsView, {
      projectId: "p1",
      data: data(),
      rowHrefs: { "reranker-shadow": `${ROOT}/quality/experiments?experiment=reranker-shadow` },
      windowPhrase: "the last 3 months",
      wider: null,
      now: NOW,
      ...props,
    }),
    { pathname: `${ROOT}/quality/experiments` },
  );
}

test("the list of experiments with its three numbers, the open one selected", () => {
  const html = view();
  assert.match(html, /data-tab="experiments"/);
  assert.match(html, /<caption class="sr-only">Experiments in this window<\/caption>/);
  for (const header of [
    "Experiment",
    "Searches compared",
    "Agreement on first pick",
    "Same order",
    "Coverage",
    "Last seen",
  ]) {
    assert.match(html, new RegExp(`<th[^>]*>${header}</th>`));
  }
  assert.match(
    html,
    /<tr[^>]*aria-current="true"[^>]*data-selected="true"[^>]*>[\s\S]*?reranker-shadow/,
  );
  assert.match(html, /36 runs/, "a plain A/B shows its runs, not comparisons it never made");
});

test("the open experiment: the KPIs in plain words, its variants and its disagreements", () => {
  const html = view();
  const text = visibleText(html);
  assert.match(text, /Current variant control , comparison shadow/);
  for (const label of ["Agreement on first pick", "Same order", "Coverage"]) {
    assert.match(html, new RegExp(`<dt[^>]*>${label}</dt>`));
  }
  assert.match(html, />73%</);
  assert.match(html, /Over 40 searches compared/);
  assert.match(
    html,
    /<a[^>]*href="\/project\/p1\/calibration\/e~reranker-shadow\?range=3m"[^>]*>Latency and reliability/,
  );
  assert.match(html, /<h2[^>]*>Where they disagreed \(13\)<\/h2>/);
  assert.match(html, /The 1 most recent\./);
  assert.match(html, /Different first pick/);
  assert.doesNotMatch(text, /\u2014|Jaccard|Top-1|nDCG|arm\b/i);
});

test("states: none in the window, a failed read, an experiment without comparisons, full agreement", () => {
  const none = view({
    data: data({ rows: [], selected: null }),
    windowPhrase: "the last 7 days",
    wider: { href: `${ROOT}/quality/experiments?range=30d`, label: "Last 30 days" },
  });
  assert.match(none, /No experiments in the last 7 days/);
  assert.match(
    none,
    /<a[^>]*href="\/project\/p1\/quality\/experiments\?range=30d"[^>]*>Last 30 days<\/a>/,
  );
  assert.match(view({ data: null }), /role="alert"[\s\S]*Couldn&#x27;t load experiments/);
  const generic = view({
    data: data({
      selected: {
        row: GENERIC,
        kpis: null,
        disagreements: [],
        detailHref: `${ROOT}/calibration/e~retrieval-v2`,
      },
    }),
  });
  assert.match(generic, /retrieval-v2 did not compare rankings/);
  assert.match(generic, /href="\/project\/p1\/calibration\/e~retrieval-v2"/);
  const agreed = view({ data: data({ selected: { ...data().selected!, disagreements: [] } }) });
  assert.match(agreed, /The variants agreed on every search/);
});

test("the selection panel: both rankings side by side, marked against each other", () => {
  const html = render(createElement(DisagreementDetail, { projectId: "p1", row: disagreement() }));
  assert.match(html, /Current: control[\s\S]*Shown to your agent[\s\S]*Comparison: shadow/);
  assert.equal(html.match(/<li data-rank=/g)?.length, 3);
  assert.match(html, /2nd in the other/);
  assert.equal(html.match(/>Only here</g)?.length, 2);
  assert.match(html, /Agreement[\s\S]*50%/);
  // The search reopens by the experiment's ids: its words stay out of the link.
  assert.match(
    html,
    /<a[^>]*href="\/project\/p1\/playground\?selection=sel-1&amp;experiment=reranker-shadow"[^>]*>[\s\S]*Test this search/,
  );
  // Tools are pins.
  assert.match(html, /<span class="[^"]*font-mono[^"]*"><svg[^>]*lucide-wrench[\s\S]*?review_pr/);
  assert.match(html, /<a[^>]*href="\/project\/p1\/traces\/abc"[^>]*>[\s\S]*Open trace/);
  const bare = render(
    createElement(DisagreementDetail, {
      projectId: "p1",
      row: disagreement({ traceHref: null, test: null }),
    }),
  );
  assert.doesNotMatch(bare, /Open trace|Test this search/);
});
