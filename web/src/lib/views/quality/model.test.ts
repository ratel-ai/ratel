import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calibrationRedirectHref,
  descriptionsHref,
  legacySuggestionId,
  percent,
  plural,
  pointChange,
  previousWindow,
  qualityTabHref,
  qualityTabLinks,
  resolveQualityWindow,
  rewritePeek,
  versusPhrase,
  visibleTabs,
  widerWindow,
  windowHref,
  windowOptions,
  windowPhrase,
  windowSearch,
  withParams,
} from "./model";

const NOW = new Date("2026-10-15T12:00:00.000Z");

test("a tab whose source is off is not offered", () => {
  assert.deepEqual(visibleTabs({ matchQuality: true, calibration: true }), [
    "misses",
    "descriptions",
    "experiments",
  ]);
  assert.deepEqual(visibleTabs({ matchQuality: true, calibration: false }), [
    "misses",
    "descriptions",
  ]);
  assert.deepEqual(visibleTabs({ matchQuality: false, calibration: true }), ["experiments"]);
  assert.deepEqual(visibleTabs({ matchQuality: false, calibration: false }), []);
});

test("each tab is its own URL and carries the window", () => {
  assert.equal(qualityTabHref("p1", "misses"), "/project/p1/quality");
  assert.equal(
    qualityTabHref("p1", "experiments", "?range=30d"),
    "/project/p1/quality/experiments?range=30d",
  );
  const links = qualityTabLinks("p1", ["misses", "descriptions", "experiments"], "?range=30d", {
    misses: 4,
    descriptions: 3,
    experiments: 0,
  });
  assert.deepEqual(links, [
    { href: "/project/p1/quality?range=30d", label: "Misses", exact: true, meta: "4" },
    { href: "/project/p1/quality/descriptions?range=30d", label: "Descriptions", meta: "3" },
    { href: "/project/p1/quality/experiments?range=30d", label: "Experiments" },
  ]);
});

test("Descriptions is the address other pages link to for a description update", () => {
  assert.equal(descriptionsHref("p1"), "/project/p1/quality/descriptions");
  assert.equal(
    descriptionsHref("p1", { tool: "lookup_order" }),
    "/project/p1/quality/descriptions?tool=lookup_order",
  );
  assert.equal(
    descriptionsHref("p1", { rewrite: "r-1" }),
    "/project/p1/quality/descriptions?peek=rewrite%3Ar-1",
  );
  assert.equal(
    descriptionsHref("p1", { tool: "lookup_order", rewrite: "r-1" }),
    "/project/p1/quality/descriptions?peek=rewrite%3Ar-1",
    "a rewrite is the more precise of the two",
  );
  assert.equal(rewritePeek("r-1"), "rewrite:r-1");
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  assert.equal(legacySuggestionId(id), id);
  assert.equal(legacySuggestionId([id, "x"]), id);
  assert.equal(legacySuggestionId("rewrite:1"), null);
  assert.equal(legacySuggestionId(undefined), null);
});

test("the window reads like Traces and only non-default windows travel", () => {
  const week = resolveQualityWindow({}, NOW);
  assert.equal(week.preset, "7d");
  assert.equal(windowSearch(week), "");
  const month = resolveQualityWindow({ range: "30d" }, NOW);
  assert.equal(windowSearch(month), "?range=30d");
  const custom = resolveQualityWindow(
    { range: "custom", from: "2026-10-01", to: "2026-10-05" },
    NOW,
  );
  assert.equal(windowSearch(custom), "?range=custom&from=2026-10-01&to=2026-10-05");
  assert.equal(resolveQualityWindow({ range: "nonsense" }, NOW).preset, "7d");
});

test("the window in sentences: never lowercased dates, never an em dash", () => {
  const week = resolveQualityWindow({}, NOW);
  assert.equal(windowPhrase(week), "the last 7 days");
  assert.equal(versusPhrase(week), "vs the previous 7 days");
  assert.equal(
    versusPhrase(resolveQualityWindow({ range: "3m" }, NOW)),
    "vs the previous 3 months",
  );
  const custom = resolveQualityWindow(
    { range: "custom", from: "2026-10-01", to: "2026-10-05" },
    NOW,
  );
  assert.equal(windowPhrase(custom), "this window");
  assert.equal(versusPhrase(custom), "vs the window before");
});

test("the previous window is the same length, ending where this one starts", () => {
  const before = previousWindow({
    since: new Date("2026-10-08T00:00:00Z"),
    until: new Date("2026-10-15T00:00:00Z"),
  });
  assert.equal(before.since.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(before.until.toISOString(), "2026-10-08T00:00:00.000Z");
});

test("the window menu links every preset on the same tab and keeps an open experiment", () => {
  const path = "/project/p1/quality/experiments";
  assert.equal(windowHref(path, "7d"), path);
  assert.equal(
    windowHref(path, "3m", { experiment: "shadow a", peek: null }),
    `${path}?experiment=shadow+a&range=3m`,
  );
  const options = windowOptions(path, { preset: "30d" }, { experiment: "x" });
  assert.equal(options.length, 5);
  assert.deepEqual(
    options.filter((option) => option.active).map((option) => option.label),
    ["Last 30 days"],
  );
  assert.equal(options[0]!.href, `${path}?experiment=x`);
});

test("an empty window offers the next longer one, and nothing past the longest", () => {
  assert.deepEqual(widerWindow("/q", { preset: "7d" }), {
    href: "/q?range=30d",
    label: "Last 30 days",
  });
  assert.deepEqual(widerWindow("/q", { preset: "30d" }), {
    href: "/q?range=3m",
    label: "Last 3 months",
  });
  assert.equal(widerWindow("/q", { preset: "12m" }), null);
  assert.equal(widerWindow("/q", { preset: "custom" }), null);
});

test("extra params sit on top of the window query", () => {
  assert.equal(
    withParams("/q", "?range=30d", { experiment: "a/b" }),
    "/q?range=30d&experiment=a%2Fb",
  );
  assert.equal(withParams("/q", "", { experiment: null }), "/q");
});

test("shares are whole percents and changes are points, signed", () => {
  assert.equal(percent(0.636), "64%");
  assert.equal(percent(null), "–");
  assert.equal(percent(Number.NaN), "–");
  assert.deepEqual(pointChange(0.64, 0.6), { direction: "up", text: "+4 pts" });
  assert.deepEqual(pointChange(0.6, 0.64), { direction: "down", text: "-4 pts" });
  assert.deepEqual(pointChange(0.6, 0.601), { direction: "flat", text: "0 pts" });
  assert.equal(pointChange(null, 0.5), null);
  assert.equal(plural(1, "search", "searches"), "1 search");
  assert.equal(plural(1200, "search", "searches"), "1,200 searches");
});

test("the v1 Calibration index forwards what still means something on Experiments", () => {
  assert.equal(calibrationRedirectHref("p1", {}), "/project/p1/quality/experiments");
  assert.equal(
    calibrationRedirectHref("p1", {
      project: "demo",
      range: "30d",
      experiment: "reranker-shadow",
      comparisonPage: "3",
    }),
    "/project/p1/quality/experiments?experiment=reranker-shadow&range=30d",
  );
  assert.equal(
    calibrationRedirectHref("p1", { range: "custom", from: "2026-10-01", to: ["2026-10-05", "x"] }),
    "/project/p1/quality/experiments?range=custom&from=2026-10-01&to=2026-10-05",
  );
});
