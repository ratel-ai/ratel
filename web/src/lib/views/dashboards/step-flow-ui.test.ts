import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StepFlowFields } from "@/components/console/dashboards/StepFlowFields";
import { WidgetBody } from "@/components/console/dashboards/WidgetBody";
import { type StepFlowQuery, stepFlowQuery } from "@/lib/contracts/query";
import { type StepFlowResult, stepPaths } from "@/lib/synthesis/metrics/step-flow";
import { foldStepFlow } from "@/lib/synthesis/metrics/step-flow-columns";
import { defaultSize } from "@/lib/views/dashboards/layout";
import { stepFlowFilter } from "@/lib/views/dashboards/links";
import { stepFlowModel } from "@/lib/views/dashboards/step-flow-model";
import { widgetName, widgetOfKind } from "@/lib/views/dashboards/widget";

const RANGE = { preset: "7d", from: "", to: "" };

function resultOf(query: StepFlowQuery, traces: readonly string[][]): StepFlowResult {
  const { paths, marks } = stepPaths(
    traces.map((names, index) => ({
      traceId: String(index),
      steps: names.map((name) => ({ kind: query.node, name, failed: name === "flaky" })),
    })),
    query.start === "agent"
      ? new Map(traces.map((_, index) => [String(index), index % 2 ? "writer" : "planner"]))
      : new Map(),
    query,
  );
  const { total, columns, links } = foldStepFlow(paths, query);
  const sample = { matched: traces.length + 1, read: traces.length };
  return { kind: "step_flow", total, columns, links, ...paths, marks, sample };
}

function html(query: StepFlowQuery, traces: readonly string[][]) {
  return renderToStaticMarkup(
    createElement(WidgetBody, {
      projectId: "p",
      widget: { title: "", query, chart: "step_flow" },
      result: resultOf(query, traces),
      range: RANGE,
      filters: { environments: ["prod"] },
    }),
  );
}

const TRACES = [
  ["search", "read", "answer", "send"],
  ["search", "read", "flaky"],
  ["search", "flaky"],
  ["read", "flaky"],
  ["read", "flaky"],
  [],
];

test("a full-width widget draws Start, each step and Later, with Ended and the marks", () => {
  const text = html(stepFlowQuery("tool"), TRACES);
  for (const title of ["Start: 6", "1st call: 5", "2nd call: 5", "3rd call: 2", "Later: 1"])
    assert.match(text, new RegExp(`aria-label="${title}"`));
  assert.match(text, /planner, start: 3 traces/);
  assert.match(text, /Ended without a step: 1 trace"/);
  assert.match(text, /flaky, step 2: 3 traces, often fails/);
  assert.match(text, /Later steps, from the 4th: 1 trace\. Press to open/);
  assert.match(text, /data-journey-ribbon="c1:search&gt;c2:read#/);
  assert.match(text, /Sampled: the newest 6 of 7 traces/);
  // A node opens its traces, under the dashboard's filters.
  assert.match(text, /href="\/project\/p\/traces\/turns\?[^"]*facetTool=search/);
  assert.match(text, /facetTool=search[^"]*facetEnvironment=prod/);
});

test("a bucket offers the next ones, and every ribbon joins two drawn cards", () => {
  const query = stepFlowQuery("tool", { nodes: 1 });
  assert.match(html(query, TRACES), /\+1 tool<.*show 1/);
  const result = resultOf(query, TRACES);
  for (const view of [{ width: 0 }, { width: 0, expanded: { 1: 3 }, opened: 1 }, { width: 500 }]) {
    const { layout, lanes } = stepFlowModel(result, query, view);
    const keys = new Set(lanes.flatMap(({ cards }) => cards.map(({ key }) => key)));
    assert.ok(layout.ribbons.length > 0);
    for (const { from, to } of layout.ribbons) assert.ok(keys.has(from) && keys.has(to));
  }
  assert.ok(
    stepFlowModel(result, query, { width: 0, expanded: { 1: 3 } }).lanes[1].cards.every(
      ({ kind }) => kind !== "rest",
    ),
  );
});

test("a small cell shows fewer columns, and Later opens one step at a time", () => {
  const query = stepFlowQuery("tool");
  const result = resultOf(query, TRACES);
  const lanes = (width: number, opened = 0) =>
    stepFlowModel(result, query, { width, opened }).lanes.map(({ title }) => title);
  assert.deepEqual(lanes(1300), ["Start", "1st call", "2nd call", "3rd call", "Later"]);
  assert.deepEqual(lanes(1300, 1).slice(-2), ["4th call", "Later"]);
  assert.deepEqual(lanes(700), ["Start", "1st call", "2nd call", "Later"]);
  assert.deepEqual(lanes(300), ["Start", "1st call", "Later"]);
  const wide = stepFlowModel(result, query, { width: 1300 }).layout;
  assert.ok(wide.width <= 1300);
  for (const ribbon of wide.ribbons) assert.ok(ribbon.x1 > ribbon.x0);
});

test("what comes before reads left to right, to the node on the right", () => {
  const query = stepFlowQuery("tool", { mode: "before", target: "flaky", start: "none", steps: 1 });
  const text = html(query, TRACES);
  assert.match(text, /All traces, before flaky: 4 traces/);
  const model = stepFlowModel(resultOf(query, TRACES), query, { width: 0 });
  assert.deepEqual(
    model.lanes.map(({ title }) => title),
    ["Earlier", "1st before", "flaky"],
  );
  for (const ribbon of model.layout.ribbons) assert.ok(ribbon.x1 > ribbon.x0);
});

test("no trace, no step and nothing before are told apart", () => {
  const query = stepFlowQuery("skill");
  const none = { ...resultOf(query, []), sample: { matched: 0, read: 0 } };
  const empty = renderToStaticMarkup(
    createElement(WidgetBody, {
      projectId: "p",
      widget: { title: "", query, chart: "step_flow" },
      result: none,
      range: RANGE,
      filters: {},
    }),
  );
  assert.match(empty, /No steps in this time range.*No trace matches/);
  assert.match(html(query, [[]]), /No matching trace has a skill/);
  const before = stepFlowQuery("tool", { mode: "before", target: "send" });
  assert.match(html(before, [["read"]]), /No trace has a step before send/);
});

test("a node's traces are named only where the Traces filter can say them", () => {
  const of = (query: StepFlowQuery, kind: "start" | "node" | "rest", name: string) =>
    stepFlowFilter(query, { kind, name });
  assert.deepEqual(of(stepFlowQuery("mcp_server"), "node", "crm"), { mcpServers: ["crm"] });
  assert.deepEqual(of(stepFlowQuery("model"), "node", "big"), { models: ["big"] });
  assert.deepEqual(of(stepFlowQuery("tool"), "start", "planner"), { agents: ["planner"] });
  assert.equal(of(stepFlowQuery("tool"), "start", "No agent"), null);
  const before = stepFlowQuery("tool", { mode: "before", target: "send" });
  assert.deepEqual(of(before, "start", "planner"), { agents: ["planner"], tools: ["send"] });
  assert.equal(of(stepFlowQuery("tool", { start: "intent" }), "start", "Refunds"), null);
  assert.equal(of(stepFlowQuery("skill"), "node", "triage"), null);
  assert.equal(of(stepFlowQuery("tool"), "rest", ""), null);
});

test("a new step flow takes the row and keeps the filter, and has a name of its own", () => {
  assert.deepEqual(defaultSize("step_flow"), { w: 12, h: 10 });
  const widget = widgetOfKind("step_flow", {
    title: "",
    query: {
      ...stepFlowQuery("tool"),
      kind: "flow",
      edges: 1,
      steps: 2,
      filters: { tools: ["a"] },
    },
    chart: "flow",
  } as never);
  assert.deepEqual(
    [widget.chart, widget.query],
    ["step_flow", stepFlowQuery("tool", { filters: { tools: ["a"] } })],
  );
  assert.equal(widgetName(widget), "Tool step flow by agent");
});

test("the editor asks for the node to look before in that mode only", () => {
  const form = (query: StepFlowQuery) =>
    renderToStaticMarkup(
      createElement(StepFlowFields, {
        query,
        facets: { tool: [{ value: "search", count: 1 }], model: [], service: [], environment: [] },
        onChange: () => {},
      }),
    );
  for (const label of ["Every call", "What comes before", "Steps are", "Start by"])
    assert.match(form(stepFlowQuery("tool")), new RegExp(label));
  assert.doesNotMatch(form(stepFlowQuery("tool")), /placeholder="Name the tool"/);
  assert.match(
    form(stepFlowQuery("tool", { mode: "before", target: "search" })),
    /placeholder="Name the tool"/,
  );
});
