import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  clustersQuery,
  flowQuery,
  funnelQuery,
  geographyQuery,
  metricQuery,
  type Query,
  stepFlowQuery,
} from "@/lib/contracts/query";
import { loadWidgets } from "@/lib/views/dashboards/data";
import { exportDashboard, importDashboard } from "@/lib/views/dashboards/document";
import { jsonSchemas } from "@/lib/views/dashboards/json-schemas";

const WIDGET = {
  title: "Speed",
  query: metricQuery("latency", "p95"),
  chart: "line",
  layout: { x: 0, y: 0, w: 6, h: 6 },
};
const DOCUMENT = {
  type: "ratel.dashboard",
  version: 1,
  name: "Board",
  filters: {},
  range: null,
  widgets: [WIDGET],
};

test("a document is refused by what it is, then by the widget that is wrong", () => {
  const widgets = (change: object) => ({
    ...DOCUMENT,
    widgets: [WIDGET, { ...WIDGET, ...change }],
  });
  const query = (change: object) => widgets({ query: { ...WIDGET.query, ...change } });
  const refused: [unknown, RegExp][] = [
    [null, /not a JSON object/],
    [{ ...DOCUMENT, type: "grafana" }, /its type is "grafana", not "ratel.dashboard"/],
    [{}, /not a Ratel dashboard/],
    [{ ...DOCUMENT, version: 2, range: 1 }, /Unknown dashboard version "2"\. The version is 1/],
    [{ ...DOCUMENT, name: " " }, /a name/],
    [{ ...DOCUMENT, filters: { tools: ["a"] } }, /unknown fields: filters.tools/],
    [{ ...DOCUMENT, range: "1h" }, /invalid at "range"/],
    [{ ...DOCUMENT, id: "x" }, /unknown fields: id/],
    [{ ...DOCUMENT, widgets: Array(25).fill(WIDGET) }, /24 widgets/],
    [widgets({ chart: "pie" }), /^Widget 2 "Speed": The widget settings are invalid/],
    [widgets({ chart: "table" }), /^Widget 2 "Speed": A table needs a group-by/],
    [widgets({ title: "", chart: "table" }), /^Widget 2 "Latency p95": /],
    [widgets({ layout: { x: 9, y: 0, w: 6, h: 6 } }), /^Widget 2 "Speed": The layout/],
    [widgets({ id: "x" }), /^Widget 2 "Speed": /],
    [query({ kind: "pie" }), /^Widget 2 "Speed": Unknown query kind "pie"/],
    [query({ filters: { scorer: { name: "Polite" } } }), /cannot be filtered by scorer/],
    [query({ filters: { scorer: { id: "x" } } }), /given by its name/],
    [{ ...DOCUMENT, widgets: [null] }, /^Widget 1: /],
  ];
  for (const [raw, error] of refused) {
    const read = importDashboard(raw, []);
    assert.ok(!read.ok, JSON.stringify(raw));
    assert.match(read.error, error);
  }
});

test("what an agent leaves out has its default, and overlaps are put apart", () => {
  const { filters: _, range: __, ...short } = DOCUMENT;
  const { dimensions: ___, filters: ____, ...query } = WIDGET.query;
  const read = importDashboard({ ...short, widgets: [{ ...WIDGET, query }, WIDGET] }, []);
  assert.ok(read.ok);
  assert.deepEqual([read.dashboard.filters, read.dashboard.range], [{}, null]);
  assert.deepEqual(read.dashboard.widgets[0].query, WIDGET.query);
  assert.deepEqual(
    read.dashboard.widgets.map(({ layout }) => layout.y),
    [0, 6],
  );
});

test("an export that is imported again has the same layout", () => {
  const layouts = [
    { x: 4, y: 0, w: 8, h: 6 },
    { x: 0, y: 0, w: 4, h: 3 },
    { x: 0, y: 3, w: 4, h: 3 },
    { x: 0, y: 6, w: 12, h: 24 },
  ];
  const widgets = layouts.map((layout) => ({ ...WIDGET, layout }));
  const read = importDashboard({ ...DOCUMENT, widgets }, []);
  assert.ok(read.ok);
  const exported = exportDashboard(
    {
      ...read.dashboard,
      widgets: read.dashboard.widgets.map((widget, index) => ({ ...widget, id: `${index}` })),
    },
    [],
  );
  assert.deepEqual(
    exported.widgets.map(({ layout }) => layout),
    layouts,
  );
  const again = importDashboard(JSON.parse(JSON.stringify(exported)), []);
  assert.deepEqual(again, read);
});

test("F445-7: hostile JSON is refused, never thrown on", () => {
  let deep: unknown = [];
  for (let n = 0; n < 20_000; n++) deep = [deep];
  const hostile = [{ toString: 1, valueOf: 1 }, deep, { toString: null }];
  const places: ((value: unknown) => object)[] = [
    (type) => ({ ...DOCUMENT, type }),
    (version) => ({ ...DOCUMENT, version }),
    (name) => ({ ...DOCUMENT, name }),
    (filters) => ({ ...DOCUMENT, filters }),
    (title) => ({ ...DOCUMENT, widgets: [{ ...WIDGET, title }] }),
    (query) => ({ ...DOCUMENT, widgets: [{ ...WIDGET, query }] }),
    ...["version", "kind", "measures", "dimensions", "filters", "bucket"].map(
      (key) => (value: unknown) => ({
        ...DOCUMENT,
        widgets: [{ ...WIDGET, query: { ...WIDGET.query, [key]: value } }],
      }),
    ),
    ...["measure", "aggregation"].map((key) => (value: unknown) => ({
      ...DOCUMENT,
      widgets: [
        {
          ...WIDGET,
          query: { ...WIDGET.query, measures: [{ ...WIDGET.query.measures[0], [key]: value }] },
        },
      ],
    })),
    (node) => ({ ...DOCUMENT, widgets: [{ ...WIDGET, query: { ...flowQuery("tool"), node } }] }),
    (node) => ({
      ...DOCUMENT,
      widgets: [{ ...WIDGET, query: { ...stepFlowQuery("tool"), node } }],
    }),
  ];
  for (const [index, place] of places.entries())
    for (const value of hostile) {
      const read = importDashboard(place(value), []);
      assert.ok(!read.ok, `place ${index}`);
      assert.ok(read.error.length < 400, read.error.slice(0, 400));
    }
  const read = importDashboard({ ...DOCUMENT, type: hostile[0] }, []);
  assert.ok(!read.ok && /its type is "an object"/.test(read.error));

  const nul = "a\u0000b";
  for (const place of [
    { ...DOCUMENT, name: nul },
    { ...DOCUMENT, filters: { models: [nul] } },
    { ...DOCUMENT, widgets: [{ ...WIDGET, title: nul }] },
    {
      ...DOCUMENT,
      widgets: [{ ...WIDGET, query: metricQuery("latency", "p95", { filters: { tools: [nul] } }) }],
    },
    {
      ...DOCUMENT,
      widgets: [
        {
          ...WIDGET,
          chart: "funnel",
          query: funnelQuery([
            { name: nul, condition: { type: "no_error" } },
            { name: "b", condition: { type: "tool", name: nul } },
          ]),
        },
      ],
    },
  ]) {
    const refused = importDashboard(place, []);
    assert.ok(!refused.ok && /NUL character/.test(refused.error), JSON.stringify(refused));
  }
});

test("a missing scorer is named once, does not stop the import and reads no number", async () => {
  const scored = {
    ...WIDGET,
    query: metricQuery("scorer_average", "avg", {
      // A pass or fail scorer of that name is not one the average reads.
      filters: { scorer: { name: "Depth" } } as never,
    }),
  };
  const read = importDashboard(
    { ...DOCUMENT, widgets: [scored, { ...scored, layout: { ...WIDGET.layout, x: 6 } }, WIDGET] },
    [{ id: "1", name: "Depth", verdict: true }],
  );
  assert.ok(read.ok);
  assert.deepEqual(read.dashboard.missingScorers, ["Depth"]);
  assert.equal(read.dashboard.widgets[0].missingScorer, "Depth");
  let reads = 0;
  await loadWidgets(
    "p",
    read.dashboard.widgets,
    { since: new Date(0), until: new Date(1) },

    async () => {
      reads += 1;
      return null;
    },
  );
  assert.equal(reads, 1);
});

test("a scorer deleted under its widget leaves no id in the document", () => {
  const query = metricQuery("scorer_count", "count", {
    filters: { scorer: { id: "44444444-4444-4444-8444-444444444444" } },
  });
  const document = exportDashboard(
    {
      name: "Board",
      filters: {},
      range: null,
      widgets: [{ ...WIDGET, chart: "line", id: "1", query }],
    },
    [],
  );
  assert.deepEqual((document.widgets[0].query as { filters: { scorer?: object } }).filters.scorer, {
    name: "Deleted scorer",
  });
});

test("the published JSON Schemas are the zod schemas", () => {
  for (const [name, schema] of Object.entries(jsonSchemas())) {
    const file = new URL(`../../../../../docs/schemas/${name}`, import.meta.url);
    assert.deepEqual(
      JSON.parse(readFileSync(file, "utf8")),
      JSON.parse(JSON.stringify(schema)),
      `${name} is out of date: run pnpm --filter @ratel/platform schemas:generate`,
    );
  }
});

test("each other kind is exported as it is imported, and drawn as itself only", () => {
  const queries: Query[] = [
    flowQuery("tool", {
      start: "search",
      steps: 3,
      filters: { environments: ["prod"], and: [{ environments: ["staging"] }, { tools: ["t"] }] },
    }),
    funnelQuery(
      [
        { name: "Search", condition: { type: "tool", name: "search" } },
        {
          name: "Fast",
          condition: { type: "attribute", path: "duration_ms", op: "lt", value: 900 },
        },
        { name: "Clean", condition: { type: "no_error" } },
      ],
      { order: "any_order" },
    ),
    stepFlowQuery("skill", {
      start: "intent",
      mode: "before",
      target: "triage",
      steps: 5,
      nodes: 4,
      filters: { environments: ["prod"] },
    }),
    clustersQuery("tools", { clusters: ["Deploys"], tasks: ["Release"], minSize: 5 }),
    geographyQuery("error_rate", "rate", {
      country: "US",
      filters: { services: ["support"] },
    }),
  ];
  const widgets = queries.map((query, index) => ({
    title: "",
    query,
    chart: query.kind,
    layout: { x: 0, y: index * 6, w: 6, h: 6 },
  }));
  const read = importDashboard({ ...DOCUMENT, widgets }, []);
  assert.ok(read.ok, JSON.stringify(read));
  const dashboard = {
    ...read.dashboard,
    widgets: read.dashboard.widgets.map((widget, index) => ({ ...widget, id: String(index) })),
  };
  assert.deepEqual(exportDashboard(dashboard, []).widgets, widgets);
  for (const [index, widget] of widgets.entries()) {
    const wrong = importDashboard({ ...DOCUMENT, widgets: [{ ...widget, chart: "line" }] }, []);
    assert.ok(!wrong.ok && wrong.error.includes("is drawn as a"), queries[index].kind);
  }
  const metric = importDashboard({ ...DOCUMENT, widgets: [{ ...WIDGET, chart: "flow" }] }, []);
  assert.ok(!metric.ok && /metric cannot be drawn as a flow/.test(metric.error));
});

test("a funnel's scorer is its name in a document, and one the project lacks is kept by name", () => {
  const id = "44444444-4444-4444-8444-444444444444";
  const scorers = [
    { id: "55555555-5555-4555-8555-555555555555", name: "Polite", verdict: false },
    { id, name: "Polite", verdict: true },
  ];
  const clean = { name: "Clean", condition: { type: "no_error" } };
  const polite = {
    name: "Polite",
    condition: { type: "scorer", scorer: { name: "Polite" }, result: "passed" },
  };
  const widget = {
    title: "",
    query: { version: 1, kind: "funnel", order: "in_order", steps: [clean, polite], filters: {} },
    chart: "funnel",
    layout: WIDGET.layout,
  };
  const document = { ...DOCUMENT, widgets: [widget] };
  for (const [known, missing] of [
    [scorers, undefined],
    [[], "Polite"],
  ] as const) {
    const read = importDashboard(document, known);
    assert.ok(read.ok, JSON.stringify(read));
    const [imported] = read.dashboard.widgets;
    assert.equal(imported.missingScorer, missing);
    const { query } = imported;
    assert.ok(query.kind === "funnel" && query.steps[1].condition.type === "scorer");
    if (!missing) assert.equal(query.steps[1].condition.scorer.id, id);
    const dashboard = { ...read.dashboard, widgets: [{ ...imported, id: "1" }] };
    assert.deepEqual(exportDashboard(dashboard, known).widgets, [widget]);
  }
  const byId = { ...polite, condition: { ...polite.condition, scorer: { id } } };
  const refused = importDashboard(
    { ...document, widgets: [{ ...widget, query: { ...widget.query, steps: [clean, byId] } }] },
    [],
  );
  assert.ok(!refused.ok && /given by its name/.test(refused.error));
});

test("a map's scorer is its name in a document", () => {
  const scorers = [{ id: "44444444-4444-4444-8444-444444444444", name: "Polite", verdict: true }];
  const { filters: _, ...query } = geographyQuery("scorer_pass_rate", "rate");
  const widget = {
    title: "",
    query: { ...query, filters: { scorer: { name: "Polite" } } },
    chart: "geography",
    layout: WIDGET.layout,
  };
  const read = importDashboard({ ...DOCUMENT, widgets: [widget] }, scorers);
  assert.ok(read.ok, JSON.stringify(read));
  const [imported] = read.dashboard.widgets;
  assert.equal(imported.missingScorer, undefined);
  const dashboard = { ...read.dashboard, widgets: [{ ...imported, id: "1" }] };
  assert.deepEqual(exportDashboard(dashboard, scorers).widgets, [widget]);
});
