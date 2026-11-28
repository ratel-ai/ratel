import assert from "node:assert/strict";
import { test } from "node:test";
import type { EarlierAsk } from "./domain";
import { buildCandidates, fixedSuggestions, MAX_CANDIDATES, type SuggestInput } from "./suggest";

const COST = {
  title: "Cost per day",
  rql: "select time_bucket('1 day', started_at) as day, sum(cost_usd) as cost from traces group by day",
};
const ERRORS = { title: "Errors", rql: "select rate(has_error) as error_rate from traces" };
const BY_PLAN = {
  title: "By plan",
  rql: "select properties['plan'] as plan, count(*) as n from traces group by plan",
};

const input = (over: Partial<SuggestInput> = {}): SuggestInput => ({
  target: "dashboard",
  dashboards: [],
  dashboardId: null,
  properties: [],
  tablesWithData: null,
  templates: [],
  earlierAsks: [],
  ...over,
});
const ids = (over: Partial<SuggestInput>) => buildCandidates(input(over)).map(({ id }) => id);
const ask = (words: string, outcome: EarlierAsk["outcome"]): EarlierAsk => ({
  target: "dashboard",
  words,
  outcome,
  widgets: [],
});

test("with no context the candidates keep the fixed order", () => {
  assert.deepEqual(ids({}).slice(0, 4), ["errors", "latency", "cost", "volume"]);
  assert.equal(fixedSuggestions(buildCandidates(input())).length, 4);
  assert.ok(buildCandidates(input()).length <= MAX_CANDIDATES);
});

test("a new dashboard puts first what the project's dashboards do not show yet", () => {
  const order = ids({ dashboards: [{ id: "d1", name: "Ops", widgets: [COST, ERRORS] }] });
  assert.ok(order.indexOf("latency") < order.indexOf("errors"));
  assert.ok(order.indexOf("latency") < order.indexOf("cost"));
});

test("a new widget gets what its dashboard lacks next to what it has, and never what it has", () => {
  const order = ids({
    target: "widget",
    dashboardId: "d1",
    dashboards: [
      { id: "d1", name: "Ops", widgets: [COST, ERRORS] },
      { id: "d2", name: "Other", widgets: [] },
    ],
  });
  assert.ok(!order.includes("cost"));
  assert.ok(!order.includes("errors"));
  assert.equal(order[0], "latency");
  const texts = buildCandidates(
    input({
      target: "widget",
      dashboardId: "d1",
      dashboards: [{ id: "d1", name: "Ops", widgets: [COST] }],
    }),
  ).map(({ text }) => text);
  assert.ok(texts.includes("Show p95 latency per hour"));
});

test("an indexed property no widget reads is a candidate; one a widget reads is not", () => {
  assert.ok(ids({ properties: ["plan", "region"] }).includes("property:region"));
  const used = ids({
    properties: ["plan", "region"],
    dashboards: [{ id: "d1", name: "Plans", widgets: [BY_PLAN] }],
  });
  assert.ok(!used.includes("property:plan"));
  assert.ok(used.includes("property:region"));
  assert.match(
    buildCandidates(input({ properties: ["region"] })).find(({ id }) => id === "property:region")
      ?.text ?? "",
    /by region/,
  );
});

test("a table with no data gives no candidate", () => {
  const order = ids({ tablesWithData: ["traces", "events"] });
  assert.ok(!order.includes("scores"));
  assert.ok(!order.includes("sessions"));
  assert.ok(order.includes("cost"));
  assert.deepEqual(ids({ tablesWithData: [] }), []);
});

test("a kept earlier ask raises similar candidates, a discarded one lowers them", () => {
  const plain = ids({});
  const kept = ids({ earlierAsks: [ask("my top end users", "kept")] });
  const discarded = ids({ earlierAsks: [ask("show me the errors", "discarded")] });
  assert.ok(kept.indexOf("users") < plain.indexOf("users"));
  assert.equal(kept[0], "users");
  assert.ok(discarded.indexOf("errors") > plain.indexOf("errors"));
  // An ask with no outcome yet moves nothing.
  assert.deepEqual(ids({ earlierAsks: [ask("show me the errors", null)] }), plain);
});

test("volume is shown by a count over time, not by any count", () => {
  const counted = {
    title: "By model",
    rql: "select model, count(*) as n from events group by model",
  };
  const perHour = {
    title: "Per hour",
    rql: "select time_bucket('1 hour', started_at) as hour, count(*) as n from traces group by hour",
  };
  const dashboards = (widgets: { title: string; rql: string }[]) => [
    { id: "d1", name: "Ops", widgets },
  ];
  assert.ok(
    ids({ target: "widget", dashboardId: "d1", dashboards: dashboards([counted]) }).includes(
      "volume",
    ),
  );
  assert.ok(
    !ids({ target: "widget", dashboardId: "d1", dashboards: dashboards([perHour]) }).includes(
      "volume",
    ),
  );
});

test("an ask raises its own topic only", () => {
  const plain = ids({});
  const kept = ids({ earlierAsks: [ask("cost over time", "kept")] });
  assert.equal(kept[0], "cost");
  assert.ok(kept.indexOf("latency") >= plain.indexOf("latency"));
});
