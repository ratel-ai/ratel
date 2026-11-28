import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ASK_ANSWER_SCHEMA,
  buildAskRequest,
  checkCandidate,
  checkCandidates,
  mergeRepair,
  parseAskAnswer,
} from "./domain";
import { ASK_MODEL } from "./limits";
import { askCallUsd, standInAskModel } from "./model";

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
  assert.deepEqual(parseAskAnswer('{"widgets": [{"title": 3}]}'), {
    widgets: [{ title: "", rql: "", chart: "" }],
    range: null,
  });
});

test("the local stand-in gives widgets that all compile", async () => {
  const context = { properties: [], widgets: [], otherWidgets: [], earlierAsks: [] };
  const request = buildAskRequest(
    { target: "dashboard", words: "w", range: OPTIONS.range },
    context,
  );
  const answer = await standInAskModel().complete(request);
  const checked = checkCandidates(parseAskAnswer(answer.text)?.widgets ?? [], "dashboard", OPTIONS);
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

const RATE_AND_COUNT = {
  title: "Tool error rate by tool",
  rql: "select attributes['gen_ai.tool.name'] as tool, rate(status = 'error') as error_rate, count(*) as calls from events where type = 'tool_call' group by tool order by error_rate desc limit 20",
  chart: "bar",
};
const RATE_ONLY = {
  ...RATE_AND_COUNT,
  rql: "select attributes['gen_ai.tool.name'] as tool, rate(status = 'error') as error_rate from events where type = 'tool_call' group by tool order by error_rate desc limit 20",
};

test("a line or a bar with two measures goes to the repair round, a table may have them", () => {
  assert.match(reasonOf(RATE_AND_COUNT.rql, "bar") ?? "", /one number column/);
  assert.match(
    reasonOf(
      "select time_bucket('1 day', started_at) as day, rate(has_error) as error_rate, count(*) as traces from traces group by day order by day",
      "line",
    ) ?? "",
    /one number column/,
  );
  assert.equal(reasonOf(RATE_AND_COUNT.rql, "table"), null);
  assert.equal(reasonOf(RATE_ONLY.rql, "bar"), null);
});

test("a rate and a count for a bar end as one measure, or as a table: never two measures on one scale", () => {
  const first = checkCandidates([RATE_AND_COUNT], "widget", OPTIONS);
  assert.deepEqual(first.widgets, []);
  assert.equal(first.refused.length, 1);
  // The repair round drops the count: the bar has one measure.
  const fixed = mergeRepair(first, [RATE_ONLY], "widget", OPTIONS);
  assert.deepEqual(
    fixed.widgets.map(({ chart, query }) => [chart, query.text]),
    [["bar", RATE_ONLY.rql]],
  );
  // The repair round keeps both: the widget becomes a table of the same RQL.
  const kept = mergeRepair(first, [RATE_AND_COUNT], "widget", OPTIONS);
  assert.deepEqual(
    kept.widgets.map(({ chart, query }) => [chart, query.text]),
    [["table", RATE_AND_COUNT.rql]],
  );
  assert.deepEqual(kept.refused, []);
});

test("the answer's range is kept when it is a range of the page, else none", () => {
  const answer = (range: unknown) => JSON.stringify({ widgets: [], range });
  assert.equal(parseAskAnswer(answer("14d"))?.range, "14d");
  assert.equal(parseAskAnswer(answer("30d"))?.range, "30d");
  for (const outside of ["2d", "", "last 14 days", 14, null, undefined])
    assert.equal(parseAskAnswer(answer(outside))?.range, null, String(outside));
});

test("the request asks for one number column in a line or a bar, and offers the page's ranges", () => {
  const request = buildAskRequest(
    { target: "dashboard", words: "w", range: OPTIONS.range },
    { properties: [], widgets: [], otherWidgets: [], earlierAsks: [] },
  );
  assert.match(request.system, /one number column/);
  assert.match(request.system, /rate/);
  assert.deepEqual(ASK_ANSWER_SCHEMA.properties.range.enum, ["", "7d", "14d", "30d", "3m", "12m"]);
});

test("a call of the ask model is priced at the published price of Claude Haiku 5.5", () => {
  // https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-11-28): prompts up to
  // 100,000 tokens pay 0.10 USD per million input tokens and 0.50 USD per million output tokens.
  assert.equal(ASK_MODEL, "claude-haiku-5-5");
  const usd = (inputTokens: number, outputTokens: number) =>
    Math.round(askCallUsd(ASK_MODEL, { inputTokens, outputTokens }) * 1e9) / 1e9;
  assert.equal(usd(10_000, 0), 0.001);
  assert.equal(usd(0, 10_000), 0.005);
  // Over 100,000 prompt tokens the whole call pays 0.50 and 2.50 USD per million.
  assert.equal(usd(200_000, 10_000), 0.125);
});
