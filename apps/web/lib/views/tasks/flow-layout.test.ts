import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskFlowDiagram } from "@/components/console/tasks/TaskFlowDiagram";
import { buildIntentFlow, layerGraph } from "@/lib/views/tasks/flow-layout";

test("buildIntentFlow orders tools by who sends to whom, arcs forward arrows over and backward under, and labels P(b|a)", () => {
  const flow = buildIntentFlow(
    {
      edges: [
        { a: "find", b: "assign", n: 45, na: 50 },
        { a: "assign", b: "find", n: 2, na: 20 },
        { a: "assign", b: "notify", n: 10, na: 20 },
        { a: "find", b: "notify", n: 3, na: 50 },
      ],
      tools: [
        { toolId: "find", n: 50 },
        { toolId: "assign", n: 48 },
        { toolId: "notify", n: 10 },
        { toolId: "lonely", n: 3 },
      ],
      names: { find: "Find task" },
    },
    { minP: 0 },
  );
  const col = (id: string) => flow.nodes.find((n) => n.id === id)!.column;
  assert.deepEqual(
    [col("find"), col("assign"), col("notify"), col("lonely")],
    [0, 1, 2, 3],
    "columns follow the usual order; a tool with no arrows gets a last column of its own",
  );
  assert.equal(flow.columns, 4);
  assert.equal(flow.nodes.find((n) => n.id === "find")!.label, "Find task");
  const fa = flow.arrows.find((a) => a.a === "find" && a.b === "assign")!;
  const af = flow.arrows.find((a) => a.a === "assign" && a.b === "find")!;
  assert.equal(fa.p, 0.9);
  assert.equal(fa.forward, true);
  assert.equal(fa.strong, true);
  assert.ok(fa.d.includes(" C"), "a forward arrow is a curve between columns");
  assert.equal(af.p, 0.1);
  assert.equal(af.forward, false);
  assert.equal(
    af.strong,
    true,
    "strong follows the threshold the arrow was admitted with (minP 0 here), not a fixed one",
  );
  const body = Math.max(...flow.nodes.map((n) => n.y + n.h));
  assert.ok(af.labelY > body, "a backward arrow loops under the diagram");
  const fn = flow.arrows.find((a) => a.a === "find" && a.b === "notify")!;
  assert.equal(fn.span, 2);
  assert.ok(
    Math.abs(fn.labelY - fa.labelY) > 10 || Math.abs(fn.labelX - fa.labelX) > 30,
    "labels do not meet",
  );
  assert.ok(
    flow.nodes.every(
      (n) => n.x >= 0 && n.x + n.w <= flow.width && n.y >= 0 && n.y + n.h <= flow.height,
    ),
    "nodes inside",
  );
  assert.ok(
    flow.nodes.every((a) =>
      flow.nodes.every((b) => a === b || a.column !== b.column || Math.abs(a.y - b.y) >= a.h),
    ),
    "stacked nodes do not overlap",
  );
  assert.equal(flow.hidden, 0);
  const html = renderToStaticMarkup(createElement(TaskFlowDiagram, { runs: 50, layout: flow }));
  assert.match(html, /data-flow-arrow="find&gt;assign" data-flow-strong="true"/);
  assert.match(html, />90%</);
  assert.match(html, /data-flow-column="3"/);
  assert.match(html, /data-task-flow-columns="4"/);
  assert.doesNotMatch(html, /aria-label="[^"]*assign it/, "no request text in an attribute");
  assert.match(html, /data-flow-node="lonely"/);
  assert.match(
    html,
    new RegExp(`<svg[^>]*width="${flow.width}"[^>]*height="${flow.height}"`),
    "drawn at its natural size, so its 12 px text never shrinks; a wide one scrolls",
  );
  assert.match(
    html,
    /class="fill-fg font-mono text-xs"/,
    "tool names in mono at the smallest text size",
  );
  assert.doesNotMatch(
    html,
    /coral|cream|warm-muted|fontSize/,
    "semantic tokens only, sizes from the type scale",
  );
});

test("buildIntentFlow keeps the eight most involved tools and says how many it left out", () => {
  const edges = Array.from({ length: 12 }, (_, i) => ({
    a: `t${i}`,
    b: `t${i + 1}`,
    n: 12 - i,
    na: 12,
  }));
  const flow = buildIntentFlow({ edges, tools: [], names: {} }, { maxTools: 4, minP: 0 });
  assert.equal(flow.nodes.length, 4);
  assert.equal(flow.hidden, 9);
  const sure = buildIntentFlow({ edges, tools: [], names: {} }, { maxTools: 4 });
  assert.deepEqual(
    sure.nodes.map((n) => n.id),
    ["t0", "t1", "t2"],
    "by default only hops of 90%+ admit a tool: 12 of 12 and 11 of 12",
  );
  assert.equal(sure.hidden, 10);
  assert.ok(
    flow.arrows.every(
      (a) => flow.nodes.some((n) => n.id === a.a) && flow.nodes.some((n) => n.id === a.b),
    ),
  );
});

test("rows: a chain stays on one line, a fan-out spreads around its source, separate chains take separate rows, nothing crosses", () => {
  const tools = ["a", "b", "c", "d", "e"].map((toolId, i) => ({ toolId, n: 50 - i }));
  const flow = buildIntentFlow(
    {
      edges: [
        { a: "a", b: "b", n: 40, na: 50 },
        { a: "a", b: "c", n: 8, na: 50 },
        { a: "d", b: "e", n: 30, na: 46 },
      ],
      tools,
      names: {},
    },
    { units: 50, minP: 0 },
  );
  const y = (id: string) => flow.nodes.find((n) => n.id === id)!.y;
  const col = (id: string) => flow.nodes.find((n) => n.id === id)!.column;
  assert.deepEqual([col("a"), col("b"), col("c"), col("d"), col("e")], [0, 1, 1, 0, 1]);
  assert.ok(
    y("b") < y("a") && y("c") > y("a"),
    "the stronger follower sits above the source, the weaker below",
  );
  assert.equal(y("d"), y("e"), "a chain of its own is one straight line");
  assert.ok(y("d") > y("c"), "and takes its own row under the fan-out");
  const line = flow.arrows.find((x) => x.a === "d" && x.b === "e")!;
  assert.match(line.d, /^M(\S+) (\S+) C\S+ \2 \S+ \2 \S+ \2$/, "a same-row arrow is flat");
  const labels = flow.arrows.map((x) => [x.labelX, x.labelY] as const);
  for (let i = 0; i < labels.length; i += 1)
    for (let j = i + 1; j < labels.length; j += 1)
      assert.ok(
        Math.abs(labels[i]![0] - labels[j]![0]) >= 38 ||
          Math.abs(labels[i]![1] - labels[j]![1]) >= 16,
        "labels never meet",
      );
});

test("a hop that skips over a tool on its own row arcs above it, and its label sits on the crest, off every card", () => {
  const flow = buildIntentFlow(
    {
      edges: [
        { a: "find", b: "assign", n: 28, na: 34 },
        { a: "find", b: "members", n: 6, na: 34 },
        { a: "members", b: "assign", n: 6, na: 6 },
      ],
      tools: [
        { toolId: "find", n: 34 },
        { toolId: "assign", n: 34 },
        { toolId: "members", n: 6 },
      ],
      names: {},
    },
    { units: 34, minP: 0 },
  );
  const node = (id: string) => flow.nodes.find((n) => n.id === id)!;
  assert.deepEqual([node("find").column, node("members").column, node("assign").column], [0, 1, 2]);
  assert.equal(node("find").y, node("members").y, "the chain is one row");
  const skip = flow.arrows.find((a) => a.a === "find" && a.b === "assign")!;
  assert.ok(skip.labelY < node("members").y, "the skip's label rides above the card it clears");
  for (const a of flow.arrows)
    for (const n of flow.nodes)
      assert.ok(
        !(
          a.labelX + 20 > n.x &&
          a.labelX - 20 < n.x + n.w &&
          a.labelY + 9 > n.y &&
          a.labelY - 9 < n.y + n.h
        ),
        `${a.a}>${a.b} label off ${n.id}`,
      );
  for (const a of flow.arrows)
    for (const b of flow.arrows)
      if (a !== b)
        assert.ok(
          Math.abs(a.labelX - b.labelX) >= 40 || Math.abs(a.labelY - b.labelY) >= 18,
          "labels never meet",
        );
  assert.ok(flow.nodes.every((n) => n.y >= 0) && skip.labelY >= 9, "the bump has headroom");
});

test("tools earn their place by dependency: a sure hop between rarely called tools is drawn, a busy pair with no order is not", () => {
  const edges = [
    { a: "closeout", b: "projects", n: 16, na: 16 },
    { a: "comment", b: "filter", n: 30, na: 120 },
    { a: "filter", b: "comment", n: 28, na: 110 },
    { a: "comment", b: "create", n: 25, na: 120 },
    { a: "create", b: "comment", n: 20, na: 90 },
    { a: "batch", b: "update", n: 2, na: 2 },
  ];
  const tools = [
    { toolId: "comment", n: 120 },
    { toolId: "filter", n: 110 },
    { toolId: "create", n: 90 },
    { toolId: "projects", n: 40 },
    { toolId: "closeout", n: 16 },
    { toolId: "batch", n: 2 },
    { toolId: "update", n: 2 },
  ];
  const flow = buildIntentFlow({ edges, tools, names: {} }, { maxTools: 3, units: 200 });
  assert.deepEqual(
    flow.nodes.map((n) => n.id).sort(),
    ["closeout", "projects"],
    "the surest hop first (16 of 16); batch → update (2 of 2) needs two slots and one is left; the busy tools have no hop of 90%+ and stay out",
  );
  assert.equal(flow.hidden, 5);
  const wide = buildIntentFlow({ edges, tools, names: {} }, { maxTools: 6, units: 200 });
  assert.deepEqual(wide.nodes.map((n) => n.id).sort(), ["batch", "closeout", "projects", "update"]);
  assert.deepEqual(
    wide.arrows.map((a) => `${a.a}>${a.b}`).sort(),
    ["batch>update", "closeout>projects"],
    "nothing under 90% is drawn, even between drawn tools",
  );
  const idle = buildIntentFlow(
    { edges: edges.slice(1, 5), tools: tools.slice(0, 3), names: {} },
    { maxTools: 6, units: 200 },
  );
  assert.deepEqual(idle.nodes, [], "no sure hop: nothing to draw");
  assert.equal(idle.hidden, 3);
  const html = renderToStaticMarkup(createElement(TaskFlowDiagram, { runs: 200, layout: idle }));
  assert.equal(html, "", "nothing detected renders nothing: no placeholder, no message");
});

test("layerGraph cuts a surviving cycle at its weakest edge, so every tool gets a column", () => {
  // a → b → c → a, each direction unopposed; the weakest hop (c → a, 2) is cut.
  const { column, dominant } = layerGraph(
    ["a", "b", "c"],
    [
      { a: "a", b: "b", n: 9, na: 9 },
      { a: "b", b: "c", n: 7, na: 7 },
      { a: "c", b: "a", n: 2, na: 2 },
    ],
  );
  assert.deepEqual([column.get("a"), column.get("b"), column.get("c")], [0, 1, 2]);
  assert.deepEqual(
    dominant.map((e) => `${e.a}>${e.b}`),
    ["a>b", "b>c"],
    "the cut edge is gone from the arrows that order the columns",
  );
});
