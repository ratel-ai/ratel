import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_TRACE_FACETS } from "@/lib/synthesis/traces/queries";
import { resolveOperationsView, resolveSpanListView } from "@/lib/synthesis/traces/view";
import {
  filterChips,
  filterFields,
  groupedSpanOptions,
  hasFilters,
  searchText,
  tabSearch,
  traceFilterFromSearch,
  withFilterToggled,
  withoutChip,
  withoutFilters,
  withRangePreset,
  withSearchText,
} from "./filters";

const params = (search: string) => new URLSearchParams(search);

test("every narrowing parameter becomes a chip, so no filter hides", () => {
  const chips = filterChips(
    "runs",
    "?range=7d&errorOnly=1&facetModel=gpt-5&facetModel=claude-sonnet&tool=lookup_order&facetArm=candidate&experiment=rank&minDurationMs=500&facetStatus=2&rootName=agent&cursor=x",
  );
  assert.deepEqual(
    chips.map((chip) => `${chip.field} ${chip.value}`),
    [
      "Status is Failed",
      "Run name contains agent",
      "Step status is Failed",
      "Model is gpt-5, claude-sonnet",
      "Tool is lookup_order",
      "Experiment contains rank",
      "Variant is candidate",
      "Duration over 500\u00a0ms",
    ],
  );
});

test("exact experiment links read as exact, and removing the last tag drops exactTags", () => {
  const search = "?experiment=ranking-v2&arm=candidate&exactTags=1";
  const chips = filterChips("runs", search);
  assert.deepEqual(
    chips.map((chip) => chip.field),
    ["Experiment is", "Variant is"],
  );
  const withoutExperiment = withoutChip(search, chips[0]);
  assert.equal(params(withoutExperiment).get("exactTags"), "1", "the variant is still exact");
  const withoutBoth = withoutChip(withoutExperiment, chips[1]);
  assert.equal(params(withoutBoth).has("exactTags"), false);
});

test("removing a chip drops the page cursor and the open row, and keeps the rest", () => {
  const search = "?range=30d&errorOnly=1&tool=x&cursor=abc&peek=t1&sort=cost";
  const next = params(withoutChip(search, { params: ["errorOnly"] }));
  assert.equal(next.has("errorOnly"), false);
  assert.equal(next.get("tool"), "x");
  assert.equal(next.get("range"), "30d");
  assert.equal(next.get("sort"), "cost");
  assert.equal(next.has("cursor"), false);
  assert.equal(next.has("peek"), false);
});

test("measures read as ranges in plain units", () => {
  const chips = filterChips("spans", "?minTokens=1000&maxTokens=50&maxCostUsd=0.5&scope=root");
  assert.deepEqual(
    chips.map((chip) => `${chip.field} ${chip.value}`),
    ["Tokens 50 to 1,000", "Cost under $0.50", "Showing top-level steps only"],
  );
  assert.deepEqual(chips[0].params, ["minTokens", "maxTokens"]);
});

test("logs only show the filters that narrow logs", () => {
  const chips = filterChips("logs", "?experiment=rank&tracelessOnly=1&tool=x&name=outcome");
  assert.deepEqual(
    chips.map((chip) => `${chip.field} ${chip.value}`),
    ["Experiment contains rank", "Showing logs without a run"],
  );
  assert.equal(
    searchText("logs", "?eventName=ratel.experiment"),
    "ratel.experiment",
    "the v1 event-name param still fills the box",
  );
});

test("clear filters keeps the window, sort, view options and the compare selection", () => {
  const search =
    "?range=custom&from=2026-10-01&to=2026-10-09&sort=duration&columns=experiment&compare=a&name=x&errorOnly=1&facetModel=m";
  const next = params(withoutFilters("runs", search));
  assert.deepEqual([...next.keys()], ["range", "from", "to", "sort", "columns", "compare"]);
  assert.equal(hasFilters("runs", search), true);
  assert.equal(hasFilters("runs", withoutFilters("runs", search)), false);
  assert.equal(
    hasFilters("runs", "?range=7d&exactTags=1"),
    false,
    "exactTags alone narrows nothing",
  );
});

test("the search box writes the name filter and Logs retire the old event-name param", () => {
  assert.equal(searchText("runs", "?name=%20lookup%20"), "lookup");
  assert.equal(
    params(withSearchText("runs", "?range=7d&cursor=c", "  support ")).get("name"),
    "support",
  );
  assert.equal(params(withSearchText("runs", "?name=x", "")).has("name"), false);
  const logs = params(withSearchText("logs", "?eventName=old", "outcome"));
  assert.equal(logs.get("name"), "outcome");
  assert.equal(logs.has("eventName"), false);
});

test("the add-filter popover offers the values seen in the window, with counts only in the span unit", () => {
  const facets = {
    ...EMPTY_TRACE_FACETS,
    model: [{ value: "claude-sonnet", count: 60 }],
    tool: [
      { value: "lookup_order", count: 45 },
      { value: "search_docs", count: 15 },
    ],
    name: [{ value: "chat", count: 3 }],
  };
  const runs = filterFields("runs", "?facetModel=gpt-5", facets);
  assert.deepEqual(
    runs.map((field) => field.label),
    ["Status", "Model", "Tool"],
    "empty fields are left out; Status is always offered",
  );
  const model = runs.find((field) => field.id === "model")!;
  assert.deepEqual(
    model.options.map((option) => [option.value, option.selected, option.count]),
    [
      ["gpt-5", true, undefined],
      ["claude-sonnet", false, undefined],
    ],
    "a selected value missing from the facet stays pickable",
  );
  const spans = filterFields("spans", "", facets);
  assert.deepEqual(
    spans.map((field) => field.label),
    ["Status", "Model", "Tool", "Step name"],
  );
  assert.equal(spans.find((field) => field.id === "tool")!.options[0].count, 45);
});

test("toggling a value adds or removes it; single-value fields replace", () => {
  let search = withFilterToggled("runs", "?peek=x", "model", "gpt-5");
  search = withFilterToggled("runs", search, "model", "claude-sonnet");
  assert.deepEqual(params(search).getAll("facetModel"), ["gpt-5", "claude-sonnet"]);
  search = withFilterToggled("runs", search, "model", "gpt-5");
  assert.deepEqual(params(search).getAll("facetModel"), ["claude-sonnet"]);
  search = withFilterToggled("runs", search, "tool", "a");
  search = withFilterToggled("runs", search, "tool", "b");
  assert.equal(params(search).get("tool"), "b");
  search = withFilterToggled("runs", search, "status", "failed");
  assert.equal(params(search).get("errorOnly"), "1");
  search = withFilterToggled("runs", search, "status", "failed");
  assert.equal(params(search).has("errorOnly"), false);
  assert.equal(
    params(withFilterToggled("logs", "", "experiment", "rank")).get("experiment"),
    "rank",
  );
  assert.equal(
    params(withFilterToggled("runs", "", "experiment", "rank")).get("facetExperiment"),
    "rank",
  );
  assert.equal(params(withFilterToggled("logs", "", "unlinked", "1")).get("tracelessOnly"), "1");
});

test("a preset window replaces custom days; switching tabs leaves the page and open row behind", () => {
  const preset = params(
    withRangePreset("?range=custom&from=2026-10-01&to=2026-10-02&cursor=c", "30d"),
  );
  assert.equal(preset.get("range"), "30d");
  assert.equal(preset.has("from"), false);
  assert.equal(preset.has("cursor"), false);
  assert.equal(tabSearch("?range=7d&tool=x&cursor=c&peek=p"), "?range=7d&tool=x");
});

test("grouped Spans apply the variant and top-level filters their chips show", () => {
  const query = {
    range: "7d",
    groupBy: "tool",
    scope: "root",
    arm: "candidate ",
    experiment: "rank",
    exactTags: "1",
  };
  const now = new Date("2026-10-15T12:00:00.000Z");
  const list = resolveSpanListView(query, now).queryOptions;
  const grouped = resolveOperationsView(query, now).queryOptions;
  assert.equal("arm" in grouped, false, "the operations view alone drops the variant");
  const options = groupedSpanOptions(grouped, list);
  assert.equal(options.scope, "root");
  assert.equal(options.arm, "candidate ", "exact tags keep the value as the list reads it");
  assert.equal(options.experiment, "rank");
  assert.equal(options.groupBy, "tool");
  assert.deepEqual(
    filterChips("spans", "?scope=root&arm=candidate&exactTags=1").map(
      (chip) => `${chip.field} ${chip.value}`,
    ),
    ["Variant is candidate", "Showing top-level steps only"],
    "and those are exactly the chips the bar shows",
  );
});

test("traceFilterFromSearch reads the rollup filters from the URL (RC-505)", () => {
  assert.deepEqual(
    traceFilterFromSearch(
      "?facetModel=gpt-4o&facetModel=claude&facetTool=refund&facetService=api&facetEnvironment=prod&errorOnly=1&minCostUsd=0.5&minTokens=1000&cursor=x",
    ),
    {
      models: ["gpt-4o", "claude"],
      tools: ["refund"],
      services: ["api"],
      environments: ["prod"],
      status: "failed",
      minCostUsd: 0.5,
      minTokens: 1000,
    },
  );
  assert.deepEqual(traceFilterFromSearch("?status=ok"), { status: "ok" });
  assert.deepEqual(traceFilterFromSearch("?minTokens=-3&minCostUsd=abc&facetModel=%20"), {});
  assert.deepEqual(traceFilterFromSearch(""), {});
});

const ROLLUP_FACETS = {
  model: [{ value: "gpt-4o", count: 3 }],
  tool: [{ value: "refund", count: 2 }],
  service: [{ value: "api", count: 5 }],
  environment: [],
};

test("rollup bar (RC-506): a model or tool chip goes to the URL and reads back as a chip", () => {
  let search = withFilterToggled("rollup", "?range=7d&cursor=abc", "model", "gpt-4o");
  search = withFilterToggled("rollup", search, "tool", "refund");
  search = withFilterToggled("rollup", search, "status", "ok");
  search = withFilterToggled("rollup", search, "cost", "0.1");
  search = withFilterToggled("rollup", search, "tokens", "10000");
  assert.equal(
    search,
    "?range=7d&facetModel=gpt-4o&facetTool=refund&status=ok&minCostUsd=0.1&minTokens=10000",
  );
  assert.deepEqual(
    filterChips("rollup", search).map((chip) => `${chip.field} ${chip.value}`),
    ["Status is OK", "Model is gpt-4o", "Tool is refund", "Cost over $0.10", "Tokens over 10,000"],
  );
  assert.equal(hasFilters("rollup", search), true);
  assert.equal(withoutFilters("rollup", search), "?range=7d");
  // Toggling the same value again removes it; failed replaces ok.
  assert.equal(withFilterToggled("rollup", "?facetTool=refund", "tool", "refund"), "");
  assert.equal(withFilterToggled("rollup", "?status=ok", "status", "failed"), "?status=failed");
  assert.equal(withFilterToggled("rollup", "?errorOnly=1", "status", "failed"), "");
});

test("rollup bar (RC-506): fields come from the rollup facets, with cost and token thresholds", () => {
  const fields = filterFields("rollup", "?facetTool=refund", ROLLUP_FACETS);
  assert.deepEqual(
    fields.map((field) => field.id),
    ["status", "model", "tool", "service", "cost", "tokens"],
  );
  assert.deepEqual(
    fields.find((field) => field.id === "status")?.options.map((option) => option.label),
    ["Failed", "OK"],
  );
  assert.deepEqual(fields.find((field) => field.id === "tool")?.options, [
    { value: "refund", label: "refund", count: 2, selected: true },
  ]);
  assert.deepEqual(
    fields.find((field) => field.id === "cost")?.options.map((option) => option.label),
    ["Over $0.01", "Over $0.10", "Over $1.00"],
  );
  assert.deepEqual(
    fields.find((field) => field.id === "tokens")?.options.map((option) => option.label),
    ["Over 1,000", "Over 10,000", "Over 100,000"],
  );
});
