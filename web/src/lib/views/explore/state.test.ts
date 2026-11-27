import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filterProblem,
  MAX_FILTER_BYTES,
  MAX_PACKED_FILTER_CHARS,
  MAX_TRACES_URL_CHARS,
} from "@/lib/contracts/filter-budget";
import {
  clustersQuery,
  type FunnelStep,
  flowQuery,
  funnelQuery,
  geographyQuery,
  type MetricQuery,
  metricQuery,
  stepFlowQuery,
} from "@/lib/contracts/query";
import { simplified } from "@/lib/synthesis/traces/trace-filter-clauses";
import { packFilter, traceFilterFromSearch } from "@/lib/synthesis/traces/v2/filters";
import { resolveTraceListView, resolveTraceRange } from "@/lib/synthesis/traces/view";
import { alertQueryOf, NEW_ALERT_PARAM, newAlertHref } from "@/lib/views/alerts/links";
import { parseAlertQuery } from "@/lib/views/alerts/parse-rule";
import {
  dashboardFiltersSchema,
  filtersProblem,
  shownFilters,
  withBarSearch,
  withPageFilters,
} from "@/lib/views/dashboards/filters";
import { searchFromTraceFilter, widgetTracesHref } from "@/lib/views/dashboards/links";
import { parseWidget } from "@/lib/views/dashboards/parse-widget";
import { rangeProblem, resolveWidgetRange } from "@/lib/views/dashboards/range";
import type { WidgetInput } from "@/lib/views/dashboards/types";
import {
  formOf,
  formWidget,
  metricOfForm,
  queryFilter,
  sqlWidgetQuery,
} from "@/lib/views/dashboards/widget";
import { exploreHref, explorePanelHref, exploreTracesHref } from "@/lib/views/explore/links";
import { START_PANEL, STARTING_POINTS } from "@/lib/views/explore/starts";
import {
  decodePanels,
  encodePanels,
  IN_FRAGMENT,
  MAX_STATE_CHARS,
  PANELS_PARAM,
  panelProblem,
  panelsOfAddress,
  stateOfAddress,
  withoutPanels,
  withPanels,
} from "@/lib/views/explore/state";

const METRIC: WidgetInput = {
  ...formWidget(
    formOf(
      metricQuery("latency", "p95", {
        dimensions: ["model", "agent"],
        filters: { tools: ["größe"], status: "failed", minCostUsd: 0 },
        bucket: "hour",
      }),
    ),
    "table",
  ),
  title: "Größe 中文 🚀",
};
const FOUR: WidgetInput[] = [
  METRIC,
  {
    title: "",
    query: stepFlowQuery("skill", { start: "none", mode: "before", target: "a" }),
    chart: "step_flow",
  },
  {
    title: "",
    query: funnelQuery([
      { name: "a", condition: { type: "attribute", path: "tools", op: "exists" } },
      { name: "b", condition: { type: "no_error" } },
    ]),
    chart: "funnel",
  },
  { title: "", query: geographyQuery("cost", "sum", { country: "US" }), chart: "geography" },
];
const shown = (value: string | null) => {
  const parsed = decodePanels(value);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  return parsed.panels;
};
const paramsOf = (href: string) => new URL(href, "https://x.test").searchParams;

test("one panel, and four of different kinds, come back as they were", () => {
  for (const panels of [[METRIC], FOUR, ...STARTING_POINTS.map(({ panel }) => [panel])])
    assert.deepEqual(shown(encodePanels(panels)), panels);
  const others: WidgetInput[] = [
    { title: "", query: flowQuery("tool", { start: "a" }), chart: "flow" },
    { title: "", query: clustersQuery("tools", { minSize: 0 }), chart: "clusters" },
  ];
  assert.deepEqual(shown(encodePanels(others)), others);
  assert.match(encodePanels(FOUR), /^2\.[\w-]+$/);
});

test("an address without panels starts with the traces by day", () => {
  assert.deepEqual(shown(null), [START_PANEL]);
  assert.deepEqual(shown(""), [START_PANEL]);
  assert.equal(withoutPanels(withPanels("?range=7d", FOUR)), "?range=7d");
});

test("a bad, an old or a forged value is refused with a reason", () => {
  const raw = (value: unknown) => `1.${btoa(JSON.stringify(value)).replace(/=+$/, "")}`;
  const query = { kind: "metric", measures: [{ measure: "trace_count", aggregation: "count" }] };
  for (const [value, error] of [
    ["0.W10", /another version/],
    ["3.W10", /another version/],
    ["nonsense", /another version/],
    ["1.%%%", /damaged/],
    ["1.gICA", /damaged/],
    [raw([]), /damaged/],
    [raw(Array(5).fill({ chart: "bar", query })), /damaged/],
    [raw([{ chart: "bar", query: { ...query, kind: "spans" } }]), /Unknown query kind/],
    [raw([{ chart: "flow", query: sqlWidgetQuery("select count(*) from traces") }]), /a flow/],
    [raw([{ chart: "flow", query }]), /A metric cannot be drawn as a flow/],
    [`2.${"A".repeat(MAX_STATE_CHARS)}`, /too long/],
  ] as const) {
    const parsed = decodePanels(value);
    assert.ok(!parsed.ok, value.slice(0, 40));
    assert.match(parsed.error, error);
  }
});

test("a link of the encoding before this one still opens", () => {
  const raw = [
    {
      chart: "line",
      query: { kind: "metric", measures: [{ measure: "latency", aggregation: "p95" }] },
    },
  ];
  // A metric of an older link opens as RQL that its form writes.
  assert.deepEqual(shown(`1.${btoa(JSON.stringify(raw)).replace(/=+$/, "")}`), [
    formWidget(formOf(metricQuery("latency", "p95")), "line"),
  ]);
  // An older RQL panel of chart "sql" opens as a table, and a metric table needs no group-by.
  const sql = sqlWidgetQuery("select count(*) from traces");
  const older = [
    { chart: "sql", query: sql },
    { chart: "table", query: { kind: "metric", measures: raw[0].query.measures } },
  ];
  assert.deepEqual(shown(`1.${btoa(JSON.stringify(older)).replace(/=+$/, "")}`), [
    { title: "", query: sql, chart: "table" },
    formWidget(formOf(metricQuery("latency", "p95")), "table"),
  ]);
});

/** Text that deflate cannot shorten. */
function noise(length: number, seed: number): string {
  let state = seed;
  return Array.from({ length }, () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return String.fromCharCode(33 + ((state >> 8) % 90)).replace(/["\\]/, "x");
  }).join("");
}
const TOO_LONG = "The filters are too long: 3,073 bytes of JSON, 3,072 at most.";
/** A panel whose filter is exactly as long as a filter may be. */
function largest(seed: number, bytes: number = MAX_FILTER_BYTES): WidgetInput {
  const filters = (last: string) => ({
    tools: [noise(900, seed)],
    and: [{ agents: [noise(600, seed + 1)] }, { tools: [noise(800, seed + 2), last] }],
  });
  const spare = bytes - JSON.stringify(filters("")).length;
  return {
    ...formWidget(
      formOf(metricQuery("latency", "p95", { filters: filters(noise(spare, seed + 3)) })),
      "line",
    ),
    title: noise(80, seed),
  };
}
const opened = (address: string) => {
  const { searchParams, hash } = new URL(address, "https://x.test/explore");
  const parsed = panelsOfAddress(`?${searchParams}`, hash);
  assert.ok(parsed?.ok, parsed?.ok === false ? parsed.error : "");
  return parsed.panels;
};

test("the largest panel, and four of them, fit an address", () => {
  const four = [1, 101, 201, 301].map((seed) => largest(seed));
  assert.equal(JSON.stringify(queryFilter(four[0].query)).length, MAX_FILTER_BYTES);
  for (const panels of [[four[0]], four]) {
    const address = withPanels("?range=7d&facetAgent=a", panels);
    const [search, hash] = address.split("#");
    // The server reads a short address; the fragment never reaches it.
    assert.ok(search.length <= 3_000);
    assert.equal(new URLSearchParams(search).get(PANELS_PARAM), IN_FRAGMENT);
    assert.ok(hash.length <= MAX_STATE_CHARS, String(hash.length));
    assert.deepEqual(opened(address), panels);
    assert.equal(stateOfAddress(search, `#${hash}`), hash);
    assert.equal(withoutPanels(address), "?range=7d&facetAgent=a");
  }
  // The server cannot know them; a link that lost its fragment says so.
  const search = withPanels("", four).split("#")[0];
  assert.equal(panelsOfAddress(search, null), null);
  const lost = panelsOfAddress(search, "");
  assert.ok(lost && !lost.ok && /lost its panels/.test(lost.error));
});

test("an edit one step over a bound is refused, and what it edits still fits", () => {
  assert.equal(panelProblem(largest(7)), null);
  assert.equal(panelProblem(largest(7, MAX_FILTER_BYTES + 1)), TOO_LONG);
  assert.match(panelProblem({ ...METRIC, title: "x".repeat(81) }) ?? "", /80 characters/);
  // The form writes each value into the text: the text bound refuses it first.
  const many = { tools: Array.from({ length: 1_001 }, (_, i) => `${i}`) };
  assert.match(
    panelProblem({
      ...METRIC,
      ...formWidget(formOf(metricQuery("latency", "p95", { filters: many })), "line"),
    }) ?? "",
    /The RQL text has at most 4,000 characters/,
  );
});

test("a panel with a text not written yet is in the address as it is", () => {
  const steps: FunnelStep[] = [
    { name: "", condition: { type: "tool", name: "" } },
    { name: "key", condition: { type: "attribute", path: "attributes.", op: "gt", value: "ab" } },
    { name: "value", condition: { type: "attribute", path: "models", op: "eq", value: "" } },
  ];
  const drafts: WidgetInput[] = [
    { title: "", query: funnelQuery(steps), chart: "funnel" },
    { title: "", query: stepFlowQuery("tool", { mode: "before", target: "" }), chart: "step_flow" },
  ];
  for (const draft of drafts) {
    assert.equal(panelProblem(draft), null);
    assert.deepEqual(opened(withPanels("", [draft])), [draft]);
  }
  // Only a text: a wrong shape is still refused.
  const wrong = [{ name: "", condition: { type: "nothing" } }, steps[0]] as FunnelStep[];
  assert.ok(panelProblem({ title: "", query: funnelQuery(wrong), chart: "funnel" }));
});

test("Open in Explore carries the widget, the filters and the range", () => {
  const stored = { ...METRIC, id: "w1", layout: { x: 0, y: 0, w: 1, h: 1 } };
  const filters = { environments: ["prod"], agents: ["a", "b"] };
  const custom = { preset: "custom", from: "2026-11-01", to: "2026-11-03" };
  const href = explorePanelHref("p1", stored, { filters, range: custom });
  assert.ok(href.startsWith("/project/p1/explore?"));
  const params = paramsOf(href);
  assert.deepEqual(shown(params.get(PANELS_PARAM)), [METRIC]);
  assert.deepEqual(shownFilters(`?${params}`, {}), filters);
  assert.deepEqual(
    ["range", "from", "to"].map((name) => params.get(name)),
    ["custom", custom.from, custom.to],
  );
  const preset = exploreHref("p1", {
    panels: FOUR,
    filters: {},
    range: { ...custom, preset: "7d" },
  });
  assert.equal(paramsOf(preset).get("range"), "7d");
  assert.equal(paramsOf(preset).get("from"), null);
  const large = largest(5);
  const link = explorePanelHref("p1", large, { filters, range: custom });
  assert.deepEqual(opened(link), [large]);
  assert.deepEqual(shownFilters(new URL(link, "https://x.test").search, {}), filters);
});

test("from the Traces page the bar takes its filters and the panel keeps the others", () => {
  const search = "?facetModel=gpt&facetAgent=a&facetTool=search&status=failed&minCostUsd=0.1&q=x";
  const params = paramsOf(exploreTracesHref("p1", search, { preset: "24h", from: "", to: "" }));
  assert.deepEqual(shownFilters(`?${params}`, {}), { models: ["gpt"], agents: ["a"] });
  assert.equal(params.get("range"), "24h");
  const filters = { tools: ["search"], status: "failed" as const, minCostUsd: 0.1 };
  assert.deepEqual(shown(params.get(PANELS_PARAM)), [
    formWidget(formOf(metricQuery("trace_count", "count", { bucket: "day", filters })), "bar"),
  ]);
});

test("a large trace filter is carried whole", () => {
  const tools = Array.from({ length: 60 }, (_, i) => `tool-${noise(20, i)}`);
  const agents = Array.from({ length: 60 }, (_, i) => `agent-${noise(6, i)}`);
  const params = new URLSearchParams([
    ...tools.map((tool) => ["facetTool", tool]),
    ...agents.map((agent) => ["facetAgent", agent]),
  ]);
  const href = exploreTracesHref("p1", `?${params}`, { preset: "30d", from: "", to: "" });
  const [panel] = opened(href);
  assert.deepEqual(shownFilters(new URL(href, "https://x.test").search, {}), { agents });
  assert.deepEqual(queryFilter(panel.query), { tools });
  assert.equal(paramsOf(href).get("range"), "30d");
});

/** A page filter, and a panel that has room for exactly it. */
const PAGE = { agents: [noise(300, 1)], models: ["\u0001".repeat(60)] };
function fullest(seed: number, over = 0): WidgetInput {
  const room = JSON.stringify(PAGE).length + ",".length;
  return largest(seed, MAX_FILTER_BYTES - room + over);
}
/** The metric query of a panel's form: what the page filters narrow, and what an alert reads. */
function metricOfPanel({ query }: WidgetInput): MetricQuery {
  assert.ok(query.kind === "sql" && query.form, "a panel of the metric form");
  return metricOfForm(query.form);
}
const exact = {
  preset: "exact",
  from: "2026-11-17T18:00:00.000Z",
  to: "2026-11-17T19:00:00.000Z",
};

test("View traces carries the longest filter whole, in an address that a request takes", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const merged = withPageFilters(metricOfPanel(fullest(seed)), PAGE);
    assert.equal(JSON.stringify(queryFilter(merged)).length, MAX_FILTER_BYTES);
    const groups = [{ by: "service" as const, value: noise(500, seed + 50) }];
    for (const [named, extra] of [
      [[], {}],
      [groups, { services: [groups[0].value] }],
    ] as const) {
      const href = widgetTracesHref(
        "00000000-0000-4000-8000-000000000000",
        queryFilter(merged),
        exact,
        [...named],
      );
      assert.ok(href.length <= MAX_TRACES_URL_CHARS, String(href.length));
      const packed = paramsOf(href).get("and") ?? "";
      assert.ok(packed.length <= MAX_PACKED_FILTER_CHARS, String(packed.length));
      const { search } = new URL(href, "https://x.test");
      const read = traceFilterFromSearch(search, { entities: true });
      const { and = [], ...own } = simplified({ ...queryFilter(merged), ...extra });
      assert.deepEqual(read, { and: [own, ...and] });
      const list = Object.fromEntries(paramsOf(href));
      const { since, until } = resolveTraceRange(list, new Date());
      assert.deepEqual([since.toISOString(), until.toISOString()], [exact.from, exact.to]);
    }
  }
});

test("the budget is what the measured request leaves", () => {
  assert.equal(MAX_TRACES_URL_CHARS, 6_144);
  assert.equal(MAX_PACKED_FILTER_CHARS, 5_504);
  assert.equal(MAX_FILTER_BYTES, 3_072);
  // Text that deflate cannot shorten, also when it is not ASCII.
  for (const seed of [1, 2, 3]) {
    const text = (bytes: number) => noise(bytes - '{"tools":[""]}'.length, seed);
    assert.ok(
      packFilter({ tools: [text(MAX_FILTER_BYTES + 1_024)] }).length <= MAX_PACKED_FILTER_CHARS,
    );
    const wide = Array.from({ length: 1_000 }, (_, i) =>
      String.fromCharCode(0x4e00 + ((i * 7_919 * seed) % 20_000)),
    ).join("");
    assert.equal(filterProblem({ tools: [wide] }), null);
    assert.ok(packFilter({ tools: [wide] }).length <= MAX_PACKED_FILTER_CHARS);
  }
});

test("the fullest panels with their page filters fit an address, a widget and an alert link", () => {
  const four = [1, 1_001, 2_001, 3_001].map((seed) => fullest(seed));
  // The page filters narrow the metric of a panel's form: its widget and its alert read them.
  const queries = four.map(metricOfPanel);
  assert.equal(filtersProblem(queries, PAGE), null);
  assert.deepEqual(opened(withPanels("?range=7d", four)), four);
  const saved = withPageFilters(queries[0], PAGE);
  assert.ok(parseWidget(formWidget(formOf(saved), "line"), { customMonitoring: true }).ok);
  const { hash, searchParams } = new URL(newAlertHref("p1", saved, true), "https://x.test");
  const value = searchParams.get(NEW_ALERT_PARAM) ?? "";
  const parsed = parseAlertQuery(alertQueryOf(value === "hash" ? hash.slice(1) : value), {
    customMonitoring: true,
  });
  assert.ok(parsed.ok);
  // An alert keeps the metric as the form of its RQL.
  assert.deepEqual(parsed.query.form, formOf(saved));
  // One byte more is refused in the bar, in a panel and in the alert.
  const over = metricOfPanel(fullest(1, 1));
  assert.equal(filtersProblem([over], PAGE), TOO_LONG);
  assert.equal(panelProblem(formWidget(formOf(withPageFilters(over, PAGE)), "line")), TOO_LONG);
  const alert = parseAlertQuery(withPageFilters(over, PAGE), { customMonitoring: true });
  assert.deepEqual(alert, { ok: false, error: TOO_LONG });
});

test("the longest filters of a bar are packed in the address, and no longer ones are taken", () => {
  const filters = (bytes: number) => ({
    agents: [noise(1_900, 3)],
    models: [noise(bytes - JSON.stringify({ agents: [noise(1_900, 3)], models: [""] }).length, 4)],
  });
  const longest = filters(MAX_FILTER_BYTES);
  assert.ok(dashboardFiltersSchema.safeParse(longest).success);
  const address = withBarSearch("?range=7d", searchFromTraceFilter(longest), {});
  assert.ok(address.length < 4_500, String(address.length));
  assert.deepEqual(shownFilters(address, {}), longest);
  assert.equal(withBarSearch(address, "", {}), "?range=7d");
  const view = { filters: longest, range: exact, panels: [METRIC] };
  assert.deepEqual(
    shownFilters(new URL(exploreHref("p1", view), "https://x.test").search, {}),
    longest,
  );
  const refused = dashboardFiltersSchema.safeParse(filters(MAX_FILTER_BYTES + 1));
  assert.equal(refused.error?.issues[0].message, TOO_LONG);
  assert.equal(filtersProblem([], filters(MAX_FILTER_BYTES + 1)), TOO_LONG);
});

test("a trace link of 130 tool names is short enough for a request, and whole (200 are over the budget)", () => {
  const tools = Array.from({ length: 130 }, (_, index) => `a-long-tool-name-${index}`);
  const filter = { tools, and: [{ tools: ["x"] }, { agents: ["a"] }] };
  assert.equal(filterProblem(filter), null);
  assert.ok(
    filterProblem({ tools: Array.from({ length: 200 }, (_, i) => `a-long-tool-name-${i}`) }),
  );
  const range = { preset: "7d", from: "", to: "" };
  const href = widgetTracesHref("p1", filter, range, [{ by: "model", value: "m" }]);
  assert.ok(href.length < 3_000, String(href.length));
  const read = traceFilterFromSearch(new URL(href, "https://x.test").search, { entities: true });
  assert.deepEqual(read, { and: [{ tools, agents: ["a"], models: ["m"] }, { tools: ["x"] }] });
});

test("an exact range is two instants, also for a list of traces", () => {
  const now = new Date("2026-11-25T10:00:00Z");
  const range = {
    preset: "exact",
    from: "2026-11-24T12:00:00.000Z",
    to: "2026-11-24T13:00:00.000Z",
  };
  const params = Object.fromEntries(
    paramsOf(exploreHref("p1", { panels: [METRIC], filters: {}, range })),
  );
  const read = resolveWidgetRange(params, now);
  assert.deepEqual(read, { ...range, since: new Date(range.from), until: new Date(range.to) });
  const list = Object.fromEntries(paramsOf(widgetTracesHref("p1", {}, read)));
  const { since, until } = resolveTraceRange(list, now);
  assert.deepEqual({ since, until }, { since: read.since, until: read.until });
  assert.equal(resolveTraceListView(list, now).queryOptions.summaryWindow, true);
  assert.equal(rangeProblem(params), null);
  for (const bad of [
    { range: "exact" },
    { range: "exact", from: "2026-11-24", to: "2026-11-25" },
    { ...params, from: params.to, to: params.from },
    { ...params, from: "2020-01-01T00:00:00Z" },
  ])
    assert.match(rangeProblem(bad) ?? "", /time range of the link is damaged/);
  assert.equal(withoutPanels("?range=exact&from=a&to=b&facetAgent=x"), "?facetAgent=x");
  // A day range is as it was.
  const days = resolveWidgetRange({ range: "custom", from: "2026-11-20", to: "2026-11-21" }, now);
  assert.deepEqual(
    [days.since.toISOString(), days.until.toISOString()],
    ["2026-11-20T00:00:00.000Z", "2026-11-22T00:00:00.000Z"],
  );
});
