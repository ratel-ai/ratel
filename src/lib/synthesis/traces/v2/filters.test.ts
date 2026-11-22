import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_TRACE_FACETS } from "@/lib/synthesis/traces/queries";
import { resolveOperationsView, resolveSpanListView } from "@/lib/synthesis/traces/view";
import {
  filterChips,
  filterFields,
  groupedSpanOptions,
  hasFilters,
  pivotFilterSearch,
  rollupFilterQuery,
  searchText,
  tabSearch,
  traceFilterFromSearch,
  withFilterToggled,
  withoutChip,
  withoutFilters,
  withoutRollupFilters,
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

// — RC-790: the Agent and MCP server filters, behind cloud-project-entities —

const ENTITY_SEARCH =
  "?range=7d&facetAgent=researcher&facetAgent=supervisor&facetServer=docs-mcp&facetModel=gpt-4o&cursor=abc";
const ENTITY_FACETS = {
  ...EMPTY_TRACE_FACETS,
  agent: [
    { value: "supervisor", count: 4 },
    { value: "researcher", count: 2 },
  ],
  server: [{ value: "docs-mcp", count: 3 }],
};
const ON = { entities: true };

test("with the entity filters on, facetAgent and facetServer are read, shown as chips and offered as fields", () => {
  assert.deepEqual(traceFilterFromSearch(ENTITY_SEARCH, ON), {
    models: ["gpt-4o"],
    agents: ["researcher", "supervisor"],
    mcpServers: ["docs-mcp"],
  });
  assert.deepEqual(
    filterChips("rollup", ENTITY_SEARCH, ON).map((chip) => `${chip.field} ${chip.value}`),
    ["Model is gpt-4o", "Agent is researcher, supervisor", "MCP server is docs-mcp"],
  );
  const fields = filterFields("rollup", ENTITY_SEARCH, ENTITY_FACETS, ON);
  const agent = fields.find((field) => field.id === "agent");
  assert.equal(agent?.label, "Agent");
  assert.deepEqual(
    agent?.options.map((option) => [option.value, option.count, option.selected]),
    [
      ["supervisor", 4, true],
      ["researcher", 2, true],
    ],
  );
  const server = fields.find((field) => field.id === "server");
  assert.equal(server?.label, "MCP server");
  assert.deepEqual(
    server?.options.map((option) => [option.value, option.selected]),
    [["docs-mcp", true]],
  );

  assert.equal(hasFilters("rollup", "?facetAgent=researcher", ON), true);
  assert.equal(withoutFilters("rollup", ENTITY_SEARCH, ON), "?range=7d");
  assert.equal(
    rollupFilterQuery(ENTITY_SEARCH, ON).toString(),
    "facetModel=gpt-4o&facetAgent=researcher&facetAgent=supervisor&facetServer=docs-mcp",
  );
  assert.equal(withoutRollupFilters(ENTITY_SEARCH, ON), "?range=7d&cursor=abc");
  // An entity page links to its runs with one parameter; a click adds or removes a value.
  assert.equal(
    withFilterToggled("rollup", "?range=7d", "agent", "researcher"),
    "?range=7d&facetAgent=researcher",
  );
  assert.equal(withFilterToggled("rollup", "?facetServer=docs-mcp", "server", "docs-mcp"), "");
});

test("with the entity filters off, facetAgent and facetServer are ignored and no facet shows", () => {
  for (const options of [undefined, { entities: false }]) {
    assert.deepEqual(traceFilterFromSearch(ENTITY_SEARCH, options), { models: ["gpt-4o"] });
    assert.deepEqual(
      filterChips("rollup", ENTITY_SEARCH, options).map((chip) => `${chip.field} ${chip.value}`),
      ["Model is gpt-4o"],
    );
    // Even when a caller hands the values over, the fields are not offered.
    const fields = filterFields("rollup", ENTITY_SEARCH, ENTITY_FACETS, options);
    assert.equal(
      fields.some((field) => field.id === "agent" || field.id === "server"),
      false,
    );
    assert.equal(
      hasFilters("rollup", "?facetAgent=researcher", options),
      false,
      "the list is not filtered, so its empty state is not the filtered one",
    );
    // The parameters are not this bar's: it leaves them where they are, as before the flag.
    assert.equal(
      withoutFilters("rollup", ENTITY_SEARCH, options),
      "?range=7d&facetAgent=researcher&facetAgent=supervisor&facetServer=docs-mcp",
    );
    assert.equal(rollupFilterQuery(ENTITY_SEARCH, options).toString(), "facetModel=gpt-4o");
    assert.equal(
      withoutRollupFilters(ENTITY_SEARCH, options),
      "?range=7d&facetAgent=researcher&facetAgent=supervisor&facetServer=docs-mcp&cursor=abc",
    );
  }
});

// — RC-885: the "pivot is" filters, behind cloud-pivots —

const PIVOTS = {
  pivots: [
    { key: "client", label: "Client company" },
    { key: "tenant.id", label: "Tenant" },
  ],
};
const PIVOT_FACETS = {
  ...EMPTY_TRACE_FACETS,
  pivots: {
    client: [
      { value: "acme", count: 2 },
      { value: "globex", count: 1 },
    ],
    "tenant.id": [],
  },
};

test("only configured pivot keys are read from the URL", () => {
  const search = "?pivot.client=acme&pivot.client=globex&pivot.tenant.id=t1&pivot.secret=x";
  assert.deepEqual(traceFilterFromSearch(search, PIVOTS), {
    pivots: { client: ["acme", "globex"], "tenant.id": ["t1"] },
  });
  assert.deepEqual(traceFilterFromSearch(search), {});
  assert.deepEqual(traceFilterFromSearch(search, { pivots: [] }), {});
  assert.deepEqual(traceFilterFromSearch("?pivot.client=%20", PIVOTS), {});
});

test("a pivot filter shows as a chip with the pivot label and the raw value", () => {
  const chips = filterChips("rollup", "?pivot.client=acme&pivot.secret=x", PIVOTS);
  assert.deepEqual(chips, [
    { key: "pivot.client", field: "Client company is", value: "acme", params: ["pivot.client"] },
  ]);
  assert.deepEqual(filterChips("rollup", "?pivot.client=acme"), []);
});

test("the bar offers one field per configured pivot with its values, only with pivots", () => {
  const fields = filterFields("rollup", "?pivot.tenant.id=t9", PIVOT_FACETS, PIVOTS);
  const client = fields.find((field) => field.id === "pivot:client");
  assert.deepEqual(client, {
    id: "pivot:client",
    label: "Client company",
    options: [
      { value: "acme", label: "acme", count: 2, selected: false },
      { value: "globex", label: "globex", count: 1, selected: false },
    ],
  });
  // A picked value with no facet row stays pickable.
  assert.deepEqual(fields.find((field) => field.id === "pivot:tenant.id")?.options, [
    { value: "t9", label: "t9", selected: true },
  ]);
  assert.ok(
    !filterFields("rollup", "", PIVOT_FACETS).some((field) => field.id.startsWith("pivot:")),
  );
});

test("toggling a pivot value adds and removes it in the URL, and clear removes it", () => {
  const once = withFilterToggled("rollup", "?cursor=c1", "pivot:client", "acme");
  assert.equal(once, "?pivot.client=acme");
  const twice = withFilterToggled("rollup", once, "pivot:client", "globex");
  assert.equal(twice, "?pivot.client=acme&pivot.client=globex");
  assert.equal(withFilterToggled("rollup", twice, "pivot:client", "acme"), "?pivot.client=globex");
  assert.ok(hasFilters("rollup", once, PIVOTS));
  assert.ok(!hasFilters("rollup", once));
  assert.equal(withoutFilters("rollup", `${twice}&range=7d`, PIVOTS), "?range=7d");
  assert.equal(
    rollupFilterQuery(`${twice}&range=7d`, PIVOTS).toString(),
    "pivot.client=acme&pivot.client=globex",
  );
  assert.equal(withoutRollupFilters(`${twice}&range=7d`, PIVOTS), "?range=7d");
});

test("a pivot link filters Sessions or Turns by one value", () => {
  assert.equal(pivotFilterSearch("tenant.id", "a&b"), "?pivot.tenant.id=a%26b");
  assert.deepEqual(traceFilterFromSearch(pivotFilterSearch("tenant.id", "a&b"), PIVOTS), {
    pivots: { "tenant.id": ["a&b"] },
  });
});

// — RC-1001: one pivot control has at most 50 options, selected values included —

const FIFTY = Array.from({ length: 50 }, (_, index) => ({
  value: `c-${String(index).padStart(2, "0")}`,
  count: 100 - index,
}));

function pivotOptions(search: string, values: readonly { value: string; count: number }[]) {
  const fields = filterFields(
    "rollup",
    search,
    { ...EMPTY_TRACE_FACETS, pivots: { client: values } },
    PIVOTS,
  );
  return fields.find((field) => field.id === "pivot:client")?.options ?? [];
}

test("50 facet values and one selected value outside them give 50 options, the selected one first", () => {
  const options = pivotOptions("?pivot.client=outside-top-50", FIFTY);
  assert.equal(options.length, 50);
  assert.deepEqual(options[0], {
    value: "outside-top-50",
    label: "outside-top-50",
    selected: true,
  });
  assert.equal(options.filter((option) => option.selected).length, 1);
  // The least frequent facet value makes room.
  assert.ok(!options.some((option) => option.value === "c-49"));
});

test("a selected value inside the facets moves first and is not offered twice", () => {
  const options = pivotOptions("?pivot.client=c-10", FIFTY);
  assert.equal(options.length, 50);
  assert.deepEqual(options[0], { value: "c-10", label: "c-10", count: 90, selected: true });
  assert.equal(options.filter((option) => option.value === "c-10").length, 1);
});

test("more than 50 URL values for one pivot: the first 50 filter, and the control has 50 options", () => {
  const many = Array.from({ length: 60 }, (_, index) => `u-${index}`);
  const search = `?${many.map((value) => `pivot.client=${value}`).join("&")}`;
  const filter = traceFilterFromSearch(search, PIVOTS);
  assert.deepEqual(filter.pivots?.client, many.slice(0, 50));
  const options = pivotOptions(search, FIFTY);
  assert.equal(options.length, 50);
  assert.deepEqual(
    options.map((option) => option.value),
    many.slice(0, 50),
  );
  assert.ok(options.every((option) => option.selected));
  assert.deepEqual(filterChips("rollup", search, PIVOTS)[0].value, many.slice(0, 50).join(", "));
});

test("with fewer than 50 facet values and no outside selection the pivot options are as before", () => {
  const few = FIFTY.slice(0, 3);
  assert.deepEqual(
    pivotOptions("", few),
    few.map((item) => ({
      value: item.value,
      label: item.value,
      count: item.count,
      selected: false,
    })),
  );
  assert.deepEqual(
    pivotOptions("?pivot.client=c-01", few).map((option) => [option.value, option.selected]),
    [
      ["c-01", true],
      ["c-00", false],
      ["c-02", false],
    ],
  );
});

test("the non-pivot controls keep their options: no cap, a selected outside value on top", () => {
  const models = Array.from({ length: 50 }, (_, index) => ({
    value: `m-${index}`,
    count: 50 - index,
  }));
  const fields = filterFields(
    "rollup",
    "?facetModel=outside",
    { ...EMPTY_TRACE_FACETS, model: models },
    PIVOTS,
  );
  const model = fields.find((field) => field.id === "model")!;
  assert.equal(model.options.length, 51);
  assert.deepEqual(model.options[0], { value: "outside", label: "outside", selected: true });
  assert.deepEqual(
    model.options.slice(1).map((option) => option.value),
    models.map((item) => item.value),
  );
});

test("the conversation filter is a chip on the run list, and is no filter of the span list (AOBS-3)", () => {
  const runs = filterChips("runs", "?conversation=6b1af9ed&cursor=x");
  assert.deepEqual(
    runs.map((chip) => `${chip.field} ${chip.value}`),
    ["Conversation is 6b1af9ed"],
  );
  assert.deepEqual(filterChips("spans", "?conversation=6b1af9ed"), []);
});

test("facetHarness and facetCountry are entity filters: read, chipped and offered only with the flag on (RC-778)", () => {
  const search = "?range=7d&facetHarness=cursor&facetCountry=GB";
  const facets = {
    ...EMPTY_TRACE_FACETS,
    harness: [{ value: "cursor", count: 2 }],
    country: [{ value: "GB", count: 1 }],
  };
  assert.deepEqual(traceFilterFromSearch(search, ON), { harnesses: ["cursor"], countries: ["GB"] });
  assert.deepEqual(
    filterChips("rollup", search, ON).map((chip) => `${chip.field} ${chip.value}`),
    ["Client is cursor", "Country is GB"],
  );
  const fields = filterFields("rollup", search, facets, ON);
  assert.deepEqual(
    fields.filter((f) => f.id === "harness" || f.id === "country").map((f) => f.label),
    ["Client", "Country"],
  );
  assert.equal(
    withFilterToggled("rollup", "?range=7d", "harness", "codex"),
    "?range=7d&facetHarness=codex",
  );
  assert.equal(withoutFilters("rollup", search, ON), "?range=7d");

  assert.deepEqual(traceFilterFromSearch(search), {});
  assert.deepEqual(filterChips("rollup", search), []);
  assert.equal(
    filterFields("rollup", search, facets).some((f) => f.id === "harness" || f.id === "country"),
    false,
  );
});
