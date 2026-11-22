import assert from "node:assert/strict";
import { test } from "node:test";
import type { FlowEdge, FlowModel, FlowNode } from "@/lib/readings/trace-signals/view";
import {
  FLOW_MAX_TOOLS,
  FLOW_MAX_WIDTH,
  FLOW_MIN_WIDTH,
  FLOW_QUIET_ID,
  FLOW_SEARCH_ID,
  FLOW_VISIBLE_ROWS,
  type FlowLayout,
  type FlowLayoutNode,
  layoutFlow,
} from "@/lib/views/health/flow-layout";
import { syntheticFlow } from "@/lib/views/health/flow-synthetic";
import { MOCK_HEALTH_MODEL } from "@/lib/views/health/mock-fixture";

const SEARCH: FlowNode = {
  id: FLOW_SEARCH_ID,
  kind: "search",
  label: "Search",
  invocations: 0,
  impressions: 0,
  tint: "none",
  signalIds: [],
};

function tool(
  id: string,
  invocations = 10,
  impressions = 20,
  tint: FlowNode["tint"] = "none",
): FlowNode {
  return { id, kind: "tool", label: id, invocations, impressions, tint, signalIds: [] };
}

function edge(
  from: string,
  to: string,
  count: number,
  kind: FlowEdge["kind"] = "sequence",
): FlowEdge {
  return { from, to, kind, count, confidence: 0.8, tint: "none", signalIds: [] };
}

function pick(to: string, count: number): FlowEdge {
  return edge(FLOW_SEARCH_ID, to, count, "pick");
}

function model(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  totalTools = nodes.length,
): FlowModel {
  return { nodes, edges, totalTools };
}

function byKey(layout: FlowLayout): Map<string, FlowLayoutNode> {
  return new Map(layout.nodes.map((node) => [node.key, node]));
}

function column(layout: FlowLayout, role: FlowLayoutNode["column"]): FlowLayoutNode[] {
  return layout.nodes.filter((node) => node.column === role);
}

/** A seeded Fisher-Yates, so the permutation tests are reproducible. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Shaped like the Agent health demo at 1440 px, where the old map drew 1,584
 * units wide: thirty picked tools with long names, chains, and tools no
 * search reached.
 */
function demoShapedModel(): FlowModel {
  const long = (i: number) =>
    `${["create", "delete", "unlink", "export", "get"][i % 5]}_task_relationship_${i}`;
  const picked = Array.from({ length: 30 }, (_, i) => tool(long(i), 200 - i * 4, 700 - i * 11));
  const next = [tool("assign_task_to_member", 90, 120), tool("get_document_content", 60, 80)];
  const unreached = Array.from({ length: 6 }, (_, i) => tool(`archived_tool_${i}_never_run`, 0, 3));
  const edges = [
    ...picked.map((node, i) => pick(node.id, 160 - i * 4)),
    edge(picked[0]!.id, next[0]!.id, 40),
    edge(picked[1]!.id, next[1]!.id, 22),
    edge(next[0]!.id, next[1]!.id, 12),
  ];
  return model([SEARCH, ...picked, ...next, ...unreached], edges, 93);
}

const SAMPLES: readonly [string, FlowModel][] = [
  ["fixture", MOCK_HEALTH_MODEL.flow],
  ["demo-shaped", demoShapedModel()],
  ["synthetic 15", syntheticFlow(15)],
  ["synthetic 120", syntheticFlow(120)],
];

test("the same model lays out identically across runs and input permutations, folded and unfolded", () => {
  for (const [name, source] of SAMPLES) {
    for (const expanded of [false, true]) {
      const expected = JSON.stringify(layoutFlow(source, { expanded }));
      assert.equal(
        JSON.stringify(layoutFlow(source, { expanded })),
        expected,
        `${name} stable across runs`,
      );
      for (const seed of [1, 7, 42, 2026]) {
        const permuted = model(
          shuffled(source.nodes, seed),
          shuffled(source.edges, seed + 1),
          source.totalTools,
        );
        assert.equal(
          JSON.stringify(layoutFlow(permuted, { expanded })),
          expected,
          `${name} stable under ${seed}`,
        );
      }
    }
  }
});

test("four columns: search, what it picked, what ran next, and tools with no path", () => {
  const layout = layoutFlow(
    model(
      [SEARCH, tool("a"), tool("b"), tool("c"), tool("orphan", 0, 0, "dead")],
      [pick("a", 30), pick("c", 8), edge("a", "b", 12), edge("b", "c", 9)],
    ),
  );
  assert.deepEqual(
    layout.columns.map((c) => c.title),
    ["Search", "Picked", "Then", "No search led here"],
  );
  const rows = byKey(layout);
  assert.deepEqual(
    column(layout, "picked").map((n) => n.key),
    ["a", "b", "c"],
    "b ran after a and before c, so it is a source too",
  );
  assert.deepEqual(
    column(layout, "then")
      .map((n) => n.key)
      .sort(),
    ["b@then", "c@then"],
  );
  assert.equal(rows.get("b@then")?.id, "b", "a tool's two rows share its id");
  assert.deepEqual(
    column(layout, "unreached").map((n) => n.id),
    ["orphan"],
  );
  for (const e of layout.edges) {
    if (e.kind === "pick") assert.equal(rows.get(e.to)?.column, "picked");
    if (e.kind === "sequence") {
      assert.equal(rows.get(e.from)?.column, "picked", `${e.key} leaves Picked`);
      assert.equal(rows.get(e.to)?.column, "then", `${e.key} lands in Then, one column over`);
    }
  }
});

test("a cycle is two ribbons one column over, never a loop back", () => {
  const layout = layoutFlow(
    model([SEARCH, tool("a"), tool("b")], [pick("a", 30), edge("a", "b", 11), edge("b", "a", 3)]),
  );
  const keys = layout.edges.map((e) => e.key).sort();
  assert.deepEqual(keys, ["a>b@then", "b>a@then", "search>a"]);
  assert.ok(
    layout.edges.every((e) => e.start.x < e.end.x),
    "every ribbon runs left to right",
  );
});

test("a model with no paths draws search and one column of tools no search led to", () => {
  const layout = layoutFlow(model([SEARCH, tool("a", 0, 0, "dead"), tool("b", 0, 0, "dead")], []));
  assert.deepEqual(
    layout.columns.map((c) => c.title),
    ["Search", "No search led here"],
  );
  assert.equal(layout.edges.length, 0);
});

test("rows sort by the turns through them, and picks leave the search bar level with their tool", () => {
  const layout = layoutFlow(MOCK_HEALTH_MODEL.flow);
  const picked = column(layout, "picked").filter((n) => n.id !== FLOW_QUIET_ID);
  const weights = picked.map((n) => n.weight);
  assert.deepEqual(
    weights,
    [...weights].sort((a, b) => b - a),
    "heaviest first",
  );
  assert.equal(
    column(layout, "picked").at(-1)?.id,
    FLOW_QUIET_ID,
    "the quiet plate closes its column",
  );

  const search = byKey(layout).get(FLOW_SEARCH_ID)!;
  assert.ok(search.h > 300, "search is a tall bar, not a point");
  for (const e of layout.edges.filter((x) => x.kind === "pick")) {
    assert.equal(e.start.y, e.end.y, `${e.key} runs straight across`);
    assert.match(e.path, /^M[\d.]+ [\d.]+ H[\d.]+$/);
  }
  const starts = layout.edges.filter((x) => x.kind === "pick").map((x) => x.start.y);
  assert.equal(new Set(starts).size, starts.length, "every pick has its own port");
});

test("ribbons from one tool are stacked in the order of their targets, so they do not cross", () => {
  for (const [name, source] of SAMPLES) {
    const layout = layoutFlow(source, { expanded: true });
    const rows = byKey(layout);
    const sequences = layout.edges.filter((e) => e.kind === "sequence" && !e.minor);
    for (const node of layout.nodes) {
      const out = sequences
        .filter((e) => e.from === node.key)
        .sort((a, b) => a.start.y - b.start.y);
      const targets = out.map((e) => rows.get(e.to)!.y);
      assert.deepEqual(
        targets,
        [...targets].sort((a, b) => a - b),
        `${name}: ${node.key} outlets`,
      );
      const into = sequences.filter((e) => e.to === node.key).sort((a, b) => a.end.y - b.end.y);
      const sources = into.map((e) => e.start.y);
      assert.deepEqual(
        sources,
        [...sources].sort((a, b) => a - b),
        `${name}: ${node.key} inlets`,
      );
    }
  }
});

test("Then is ordered by where its visible ribbons come from, which keeps them from crossing in an X", () => {
  const nodes = [SEARCH, tool("top", 90), tool("bottom", 80), tool("x", 5), tool("y", 5)];
  const layout = layoutFlow(
    model(nodes, [
      pick("top", 90),
      pick("bottom", 80),
      edge("top", "y", 10),
      edge("bottom", "x", 40),
    ]),
  );
  assert.deepEqual(
    column(layout, "then").map((n) => n.id),
    ["y", "x"],
    "x is busier, but y comes from the upper tool",
  );
});

test("labels never meet a ribbon: ribbons leave past the column's labels and arrive before the plate", () => {
  for (const [name, source] of SAMPLES) {
    for (const expanded of [false, true]) {
      const layout = layoutFlow(source, { expanded });
      const rows = byKey(layout);
      const labelEnd = Math.max(...column(layout, "picked").map((n) => n.labelEnd));
      for (const e of layout.edges) {
        const from = rows.get(e.from)!;
        const to = rows.get(e.to)!;
        assert.doesNotMatch(e.path, /NaN|Infinity/);
        if (e.kind === "pick")
          assert.ok(e.end.x <= to.x - to.r, `${name}: ${e.key} stops at the plate`);
        if (e.kind === "sequence") {
          assert.ok(e.start.x > labelEnd, `${name}: ${e.key} leaves after the labels`);
          assert.ok(e.end.x < to.x - to.r, `${name}: ${e.key} arrives before the plate`);
          assert.equal(e.start.x, (from.outlet?.x ?? 0) + 3);
        }
      }
    }
  }
});

function assertNoOverlap(layout: FlowLayout, name: string) {
  for (const role of ["picked", "then", "unreached"] as const) {
    const rows = column(layout, role).sort((a, b) => a.y - b.y);
    for (let i = 1; i < rows.length; i += 1) {
      const gap = rows[i].y - rows[i - 1].y;
      assert.ok(
        gap >= Math.max(rows[i].r + rows[i - 1].r, 20),
        `${name}: ${rows[i - 1].key} and ${rows[i].key}`,
      );
    }
  }
}

test("nothing overlaps, everything is inside the frame, and the width fits the card", () => {
  for (const [name, source] of SAMPLES) {
    for (const expanded of [false, true]) {
      const layout = layoutFlow(source, { expanded });
      assertNoOverlap(layout, name);
      assert.ok(
        layout.width >= FLOW_MIN_WIDTH && layout.width <= FLOW_MAX_WIDTH,
        `${name}: ${layout.width} wide`,
      );
      for (const node of layout.nodes) {
        assert.ok(
          node.x - node.r >= 0 && node.labelEnd <= layout.width,
          `${name}: ${node.key} inside horizontally`,
        );
        assert.ok(
          node.y + Math.max(node.r, node.h / 2) <= layout.height,
          `${name}: ${node.key} inside vertically`,
        );
      }
      for (const e of layout.edges) {
        assert.ok(
          Math.max(e.start.y, e.end.y) + e.width / 2 <= layout.height,
          `${name}: ${e.key} inside`,
        );
      }
    }
  }
});

test("a long column folds behind a +N more row, keeping magnet and buried tools in sight", () => {
  const source = syntheticFlow(120);
  const folded = layoutFlow(source);
  const expanded = layoutFlow(source, { expanded: true });
  assert.ok(folded.foldable && expanded.foldable);

  const picked = column(folded, "picked");
  const more = picked.find((n) => n.kind === "more")!;
  const tools = picked.filter((n) => n.kind === "tool");
  assert.equal(tools.length, FLOW_VISIBLE_ROWS);
  assert.equal(more.text, `+${more.moreCount} more`);
  assert.equal(picked.at(-1)?.id, FLOW_QUIET_ID, "the quiet plate stays last, under the fold");
  const allPicked = column(expanded, "picked").filter((n) => n.kind === "tool");
  assert.equal(
    tools.length + more.moreCount!,
    allPicked.length,
    "the fold holds exactly the rows it hides",
  );
  assert.ok(tools.some((n) => n.tint === "magnet") && tools.some((n) => n.tint === "buried"));
  assert.ok(allPicked.length <= FLOW_MAX_TOOLS);

  // Hidden rows' ribbons land on the fold, merged; the turns are all still there.
  const turns = (layout: FlowLayout) =>
    layout.edges.filter((e) => e.kind === "pick").reduce((sum, e) => sum + e.count, 0);
  assert.equal(turns(folded), turns(expanded));
  assert.equal(
    folded.edges.filter((e) => e.to === more.key).length,
    1,
    "one merged pick into the fold",
  );

  const fewer = column(expanded, "picked").at(-1)!;
  assert.equal(fewer.kind, "more");
  assert.equal(fewer.moreCount, 0);
  assert.equal(fewer.text, "Show fewer");
  assert.equal(folded.columns.find((c) => c.role === "picked")?.hidden, more.moreCount);
});

test("the 120-tool catalog stays compact: 12 rows a column, one screen tall", () => {
  const layout = layoutFlow(syntheticFlow(120));
  for (const role of ["picked", "then"] as const) {
    assert.ok(
      column(layout, role).length <= FLOW_VISIBLE_ROWS + 2,
      `${role}: 12 rows, a fold and the quiet plate`,
    );
  }
  assert.ok(layout.height < 560, `${layout.height} units tall`);
  assert.ok(layout.edges.filter((e) => !e.minor).length <= 40, "at most 40 ribbons drawn at rest");
});

test("a column two rows over the limit does not fold; hiding two saves nothing", () => {
  const tools = Array.from({ length: FLOW_VISIBLE_ROWS + 2 }, (_, i) =>
    tool(`t${String(i).padStart(2, "0")}`, 100 - i),
  );
  const layout = layoutFlow(
    model(
      [SEARCH, ...tools],
      tools.map((t, i) => pick(t.id, 50 - i)),
    ),
  );
  assert.equal(layout.foldable, false);
  assert.equal(column(layout, "picked").length, FLOW_VISIBLE_ROWS + 2);
});

test("only the busiest ran-next ribbons and the flagged ones are drawn at rest", () => {
  const nodes = [
    SEARCH,
    ...Array.from({ length: 15 }, (_, i) => tool(`t${String(i).padStart(2, "0")}`, 100)),
  ];
  const sequences = nodes.slice(2, 15).map((n, i) => edge("t00", n.id, 100 - i * 6));
  const flagged = { ...edge("t01", "t14", 3), signalIds: ["sig-chain"] };
  const layout = layoutFlow(
    model(nodes, [
      pick("t00", 50),
      pick("t01", 40),
      ...sequences,
      flagged,
      edge("t02", "t03", 4, "sibling"),
    ]),
  );
  const majors = layout.edges.filter((e) => e.kind === "sequence" && !e.minor).map((e) => e.key);
  assert.equal(majors.length, 11, "the ten busiest and the flagged one");
  assert.ok(majors.includes("t01>t14@then"));
  assert.ok(
    layout.edges.filter((e) => e.kind === "sibling").every((e) => e.minor),
    "brackets wait for focus",
  );
  assert.ok(layout.edges.filter((e) => e.kind === "pick").every((e) => !e.minor));
});

test("ribbon width grows with turns, within bounds", () => {
  const layout = layoutFlow(MOCK_HEALTH_MODEL.flow);
  const ribbons = layout.edges
    .filter((e) => e.kind !== "sibling")
    .sort((a, b) => a.count - b.count);
  assert.ok(ribbons.every((e) => e.width >= 1.5 && e.width <= 10));
  for (let i = 1; i < ribbons.length; i += 1) assert.ok(ribbons[i].width >= ribbons[i - 1].width);
  assert.equal(ribbons.at(-1)?.key, "search>search_tasks");
  assert.equal(ribbons.at(-1)?.width, 10);
  assert.ok(layout.edges.every((e) => e.opacity > 0 && e.opacity <= 1));
});

test("past 40 tools the quietest fold into the quiet plate, and a model's own quiet plate absorbs them", () => {
  const source = syntheticFlow(120);
  const quiet = byKey(layoutFlow(source)).get(FLOW_QUIET_ID)!;
  const drawn = new Set(
    layoutFlow(source, { expanded: true })
      .nodes.filter((n) => n.kind === "tool")
      .map((n) => n.id),
  );
  assert.equal(drawn.size + quiet.quietCount!, 120);
  assert.equal(quiet.label, `and ${quiet.quietCount} quiet tools`);

  const mock = byKey(layoutFlow(MOCK_HEALTH_MODEL.flow)).get(FLOW_QUIET_ID);
  assert.equal(mock?.label, "and 78 quiet tools", "nothing to fold keeps the model's count");
});

test("an empty model lays out to nothing", () => {
  const layout = layoutFlow({ nodes: [], edges: [], totalTools: 0 });
  assert.deepEqual([layout.nodes.length, layout.edges.length, layout.columns.length], [0, 0, 0]);
});
