import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAskRequest,
  checkCandidate,
  checkCandidates,
  mergeRepair,
  parseAskAnswer,
} from "./domain";
import { standInAskModel } from "./model";

const NOW = new Date("2026-11-24T12:00:00Z");
const OPTIONS = {
  now: NOW,
  properties: ["plan"],
  range: { from: "2026-11-17T12:00:00Z", to: NOW.toISOString() },
};
const reasonOf = (rql: string, chart: string) => {
  const checked = checkCandidate({ title: "t", rql, chart }, OPTIONS);
  return checked.ok ? null : checked.refused.reason;
};

test("a widget is refused for a chart its columns cannot fill", () => {
  assert.match(
    reasonOf("select model, count(*) as n from events group by model", "line") ?? "",
    /time column/,
  );
  assert.match(
    reasonOf("select model, count(*) as n from events group by model", "number") ?? "",
    /one row/,
  );
  assert.match(reasonOf("select count(*) from traces", "pie") ?? "", /not one of/);
  assert.equal(reasonOf("select count(*) from traces", "number"), null);
});

test("a property that is not indexed is refused, an indexed one compiles", () => {
  assert.equal(
    reasonOf("select properties['plan'] as plan, count(*) as n from traces group by plan", "bar"),
    null,
  );
  assert.match(
    reasonOf("select properties['region'] as r, count(*) as n from traces group by r", "bar") ?? "",
    /region/,
  );
});

test("an answer that is not the schema's JSON gives null", () => {
  assert.equal(parseAskAnswer("not json"), null);
  assert.equal(parseAskAnswer('{"widget": []}'), null);
  assert.deepEqual(parseAskAnswer('{"widgets": [{"title": 3}]}'), [
    { title: "", rql: "", chart: "" },
  ]);
});

test("the local stand-in gives widgets that all compile", async () => {
  const context = { properties: [], widgets: [], otherWidgets: [], earlierAsks: [] };
  const request = buildAskRequest(
    { target: "dashboard", words: "w", range: OPTIONS.range },
    context,
  );
  const answer = await standInAskModel().complete(request);
  const checked = checkCandidates(parseAskAnswer(answer.text) ?? [], "dashboard", OPTIONS);
  assert.deepEqual(checked.refused, []);
  assert.equal(checked.widgets.length, 4);
});

const GOOD = { title: "Traces", rql: "select count(*) as n from traces", chart: "number" };
const BROKEN = { title: "Broken", rql: "select nothing from nowhere", chart: "bar" };
const FIX = {
  title: "Cost by model",
  rql: "select model, sum(cost_usd) as cost from events group by model",
  chart: "bar",
};

test("the repair round matches the refused widgets by order, not by title", () => {
  const first = checkCandidates([GOOD, BROKEN], "dashboard", OPTIONS);
  // The model renamed the fixed widget: it joins, and nothing stays refused.
  const renamed = mergeRepair(first, [FIX], "dashboard", OPTIONS);
  assert.deepEqual(
    renamed.widgets.map(({ title }) => title),
    ["Traces", "Cost by model"],
  );
  assert.deepEqual(renamed.refused, []);
  // A repeat of a widget the draft has already is not added twice, and the broken one stays named.
  const repeated = mergeRepair(first, [GOOD], "dashboard", OPTIONS);
  assert.deepEqual(
    repeated.widgets.map(({ title }) => title),
    ["Traces"],
  );
  assert.deepEqual(repeated.refused, first.refused);
  // A widget left out keeps its first reason, once, whatever the length of its title.
  const long = checkCandidates([{ ...BROKEN, title: "x".repeat(120) }], "dashboard", OPTIONS);
  for (const answer of [[], [{ ...BROKEN, rql: "" }]]) {
    const kept = mergeRepair(long, answer, "dashboard", OPTIONS);
    assert.equal(kept.refused.length, 1);
    assert.equal(kept.refused[0]?.reason, long.refused[0]?.reason);
  }
});

test("a draft never holds two widgets of the same RQL", () => {
  const checked = checkCandidates([GOOD, { ...GOOD, title: "Again" }], "dashboard", OPTIONS);
  assert.equal(checked.widgets.length, 1);
});
