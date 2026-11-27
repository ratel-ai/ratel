import assert from "node:assert/strict";
import { test } from "node:test";
import { clustersQuery, metricQuery } from "@/lib/contracts/query";
import { simplified, withClause } from "@/lib/synthesis/traces/trace-filter-clauses";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import {
  filterChips,
  traceFilterFromSearch,
  withoutChip,
  withoutFilters,
} from "@/lib/synthesis/traces/v2/filters";
import {
  barSearch,
  sameDefaults,
  shownFilters,
  takesPageFilters,
  withBarFilter,
  withBarSearch,
  withoutOwnView,
  withPageFilters,
} from "@/lib/views/dashboards/filters";
import { searchFromTraceFilter } from "@/lib/views/dashboards/links";
import type { DashboardFilters } from "@/lib/views/dashboards/types";

const SAVED = { environments: ["prod"], models: ["gpt"] };

test("the saved filters load when the address has none, and the address wins when it has", () => {
  assert.deepEqual(shownFilters("?range=7d", SAVED), SAVED);
  assert.equal(barSearch("?range=7d", SAVED), "?facetModel=gpt&facetEnvironment=prod");
  assert.deepEqual(shownFilters("?facetAgent=planner&facetTool=x", SAVED), { agents: ["planner"] });
  assert.equal(barSearch("?range=7d&facetAgent=planner", SAVED), "?facetAgent=planner");
});

test("a change of the bar is in the address, and clearing it does not bring the saved ones back", () => {
  const changed = withBarSearch("?range=7d", "?facetModel=gpt&facetService=a", SAVED);
  assert.equal(changed, "?range=7d&facetService=a&facetModel=gpt");
  assert.deepEqual(shownFilters(changed, SAVED), { services: ["a"], models: ["gpt"] });
  const cleared = withBarSearch(
    changed,
    withoutFilters("rollup", barSearch(changed, SAVED), { entities: true }),
    SAVED,
  );
  assert.equal(cleared, "?range=7d&filters=none");
  assert.deepEqual(shownFilters(cleared, SAVED), {});
  assert.equal(withBarSearch(cleared, "", {}), "?range=7d");
  assert.equal(withoutOwnView(`${cleared}&addScorer=x`), "?addScorer=x");
});

test("defaults are the same whatever the order of their values", () => {
  const a = { filters: { models: ["a", "b"] }, range: null };
  assert.ok(sameDefaults(a, { filters: { models: ["b", "a"], agents: [] }, range: null }));
  assert.ok(!sameDefaults(a, { ...a, range: "7d" }));
});

test("the page's filter is one more clause of a query, whatever the query's own filter is", () => {
  const query = (filters: object) => metricQuery("latency", "p95", { filters });
  const merged = (filters: object, page: object) => withPageFilters(query(filters), page).filters;
  const own = { models: ["a", "b"], tools: ["t"] };
  assert.deepEqual(merged(own, { models: ["b", "c"] }), { ...own, and: [{ models: ["b", "c"] }] });
  assert.deepEqual(merged({ environments: ["prod"] }, { environments: ["staging"] }), {
    environments: ["prod"],
    and: [{ environments: ["staging"] }],
  });
  assert.deepEqual(merged({}, SAVED), { and: [SAVED] });
  // What it already says is not added again.
  const said: [object, DashboardFilters][] = [
    [own, {}],
    [own, { agents: [] }],
    [SAVED, { models: ["gpt"], environments: ["prod"] }],
    [{ and: [SAVED] }, SAVED],
  ];
  for (const [filters, page] of said) {
    assert.deepEqual(merged(filters, page), filters);
    assert.equal(takesPageFilters(query(filters), page), false);
  }
  assert.equal(takesPageFilters(query(own), SAVED), true);
  const scorer = { id: "11111111-1111-4111-8111-111111111111" };
  const scored = metricQuery("scorer_average", "avg", { filters: { scorer } });
  assert.deepEqual(withPageFilters(scored, SAVED).filters, { and: [SAVED], scorer });
  for (const each of [metricQuery("context_cost", "sum"), clustersQuery("asks")]) {
    assert.equal(withPageFilters(each, SAVED), each);
    assert.equal(takesPageFilters(each, SAVED), false);
  }
});

test("clauses become one only where that loses nothing", () => {
  const of = (own: TraceFilter, clause: TraceFilter) => simplified(withClause(own, clause));
  // One per trace: the common values are the meaning of both, when there are some.
  assert.deepEqual(of({ services: ["a", "b"] }, { services: ["b", "c"] }), { services: ["b"] });
  const disjoint = of({ services: ["a"] }, { services: ["b"] });
  assert.deepEqual(disjoint, { services: ["a"], and: [{ services: ["b"] }] });
  // A trace can have tools of both sets.
  const tools = of({ tools: ["a", "b"] }, { tools: ["b", "c"], models: ["m"] });
  assert.deepEqual(tools, { tools: ["a", "b"], models: ["m"], and: [{ tools: ["b", "c"] }] });
  assert.deepEqual(of({ tools: ["a", "b"] }, { tools: ["a"] }), { tools: ["a"] });
  assert.deepEqual(of({ minCostUsd: 1 }, { minCostUsd: 2 }), { minCostUsd: 2 });
  assert.deepEqual(of({ status: "ok" }, { status: "failed" }), {
    status: "ok",
    and: [{ status: "failed" }],
  });
});

test("clauses survive the query string of the Traces page, and are one chip", () => {
  const filter: TraceFilter = {
    tools: ["a&b"],
    and: [{ tools: ["c d"], status: "failed" }, { environments: ["prod"] }],
  };
  const search = searchFromTraceFilter(filter);
  assert.deepEqual(traceFilterFromSearch(search, { entities: true }), filter);
  const chip = filterChips("rollup", search, { entities: true }).find(({ key }) => key === "and");
  assert.match(chip?.value ?? "", /c d.*prod/);
  assert.equal(withoutChip(search, chip as NonNullable<typeof chip>), "?facetTool=a%26b");
  for (const bad of [
    "?and=",
    "?and=x",
    "?and=z.%%",
    "?and=z.AAAA",
    "?and=z.q1YqKlGyMjQ2AQA",
    "?and=and%3DfacetModel%3Dm",
  ])
    assert.deepEqual(traceFilterFromSearch(bad, { entities: true }), {});
});

test("the page filter holds trace properties: in the address, saved, and as a clause of each query (RTL-397)", () => {
  const saved = { properties: { plan: ["pro"] } };
  assert.deepEqual(shownFilters("?range=7d", saved), saved);
  assert.equal(barSearch("?range=7d", saved), "?prop.plan=pro");
  const changed = withBarSearch("?range=7d", "?prop.org=acme&prop.org=globex&facetTool=x", saved);
  assert.equal(changed, "?range=7d&prop.org=acme&prop.org=globex");
  assert.deepEqual(shownFilters(changed, saved), { properties: { org: ["acme", "globex"] } });
  assert.deepEqual(shownFilters("?prop.plan=team", {}), { properties: { plan: ["team"] } });
  assert.equal(withoutOwnView(changed), "");
  assert.ok(
    sameDefaults(
      { filters: { properties: { a: ["1", "2"], b: ["x"] } }, range: null },
      { filters: { properties: { b: ["x"], a: ["2", "1"] } }, range: null },
    ),
  );
  assert.ok(!sameDefaults({ filters: saved, range: null }, { filters: {}, range: null }));
  const flow = withPageFilters(
    { version: 1, kind: "flow", node: "tool", steps: 6, edges: 30, filters: {} },
    saved,
  );
  assert.deepEqual(flow.filters, { and: [saved] });
});

test("the property pickers of the page edit the bar's query string as a filter", () => {
  const bar = "?facetModel=gpt&prop.plan=pro";
  const edited = withBarFilter(bar, (filter) => ({
    ...filter,
    properties: { ...filter.properties, org: ["acme"] },
  }));
  assert.deepEqual(shownFilters(withBarSearch("?range=7d", edited, {}), {}), {
    models: ["gpt"],
    properties: { plan: ["pro"], org: ["acme"] },
  });
});
