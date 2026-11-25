import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_TOPOLOGY_AGENTS,
  MAX_TOPOLOGY_SERVERS,
  type Topology,
  topologyModel,
} from "./topology";
import { type TopologyLayout, topologyLayout } from "./topology-layout";

const agent = (key: string, calls: number) => ({ key, displayName: key, calls, errorRate: 0 });
const server = (key: string, calls: number) => ({
  key,
  role: "consumed" as const,
  displayName: key,
  calls,
  errorRate: 0,
});

function graph(
  agents: string[],
  handoffs: [string, string][],
  servers: string[] = [],
  calls: [string | null, string][] = [],
): Topology {
  return topologyModel({
    agents: agents.map((key, i) => agent(key, 100 - i)),
    handoffs: handoffs.map(([from, to], i) => ({
      from,
      to,
      fromName: from,
      toName: to,
      count: 50 - i,
    })),
    servers: servers.map((key, i) => server(key, 40 - i)),
    calls: calls.map(([by, to], i) => ({ agent: by, server: to, calls: 30 - i, errors: 0 })),
    hidden: new Set(),
    names: new Map(),
  });
}

function assertSound(of: Topology): TopologyLayout {
  const layout = topologyLayout(of);
  assert.equal(layout.nodes.length, of.nodes.length, "every node is placed");
  assert.equal(layout.edges.length, of.edges.length, "every edge is drawn");
  for (const [i, a] of layout.nodes.entries()) {
    assert.ok(a.x >= 0 && a.y >= 0, `${a.id} starts in the map`);
    assert.ok(a.x + a.width <= layout.width && a.y + a.height <= layout.height, `${a.id} ends in`);
    for (const b of layout.nodes.slice(i + 1)) {
      const apart =
        a.x + a.width <= b.x ||
        b.x + b.width <= a.x ||
        a.y + a.height <= b.y ||
        b.y + b.height <= a.y;
      assert.ok(apart, `${a.id} and ${b.id} overlap`);
    }
  }
  for (const edge of layout.edges) assert.doesNotMatch(edge.path, /NaN|undefined/);
  assert.deepEqual(topologyLayout(of), layout, "the same graph draws the same map");
  return layout;
}

const columns = (layout: TopologyLayout) => {
  const xs = [...new Set(layout.nodes.map((node) => node.x))].sort((a, b) => a - b);
  return xs.map((x) => layout.nodes.filter((node) => node.x === x).map((node) => node.id));
};

test("an empty graph is an empty map", () => {
  assert.deepEqual(topologyLayout(graph([], [])), { nodes: [], edges: [], width: 0, height: 0 });
});

test("one agent", () => {
  assert.deepEqual(columns(assertSound(graph(["a"], []))), [["agent:a"]]);
});

test("six agents and three servers: a column per depth, the servers last, an isolated agent kept", () => {
  const layout = assertSound(
    graph(
      ["a", "b", "c", "d", "e", "alone"],
      [
        ["a", "b"],
        ["a", "c"],
        ["b", "d"],
        ["b", "e"],
      ],
      ["s1", "s2", "s3"],
      [
        ["a", "s1"],
        ["d", "s1"],
        ["c", "s2"],
        ["e", "s3"],
      ],
    ),
  );
  assert.deepEqual(columns(layout), [
    ["agent:a", "agent:alone"],
    ["agent:b", "agent:c"],
    ["agent:d", "agent:e"],
    ["mcp:s1", "mcp:s2", "mcp:s3"],
  ]);
});

test("an edge that skips a column crosses it between the boxes", () => {
  const layout = assertSound(graph(["a", "b"], [["a", "b"]], ["s"], [["a", "s"]]));
  const box = layout.nodes.find((node) => node.id === "agent:b");
  const edge = layout.edges.find((each) => each.from === "agent:a" && each.to === "mcp:s");
  assert.ok(box && edge);
  const crossing = [...edge.path.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)]
    .map(([, x, y]) => ({ x: Number(x), y: Number(y) }))
    .filter(({ x }) => x >= box.x && x <= box.x + box.width);
  assert.ok(crossing.length > 0);
  for (const { y } of crossing) assert.ok(y < box.y || y > box.y + box.height, `y ${y} is clear`);
});

test("MCP only: the servers are the one column", () => {
  assert.deepEqual(columns(assertSound(graph([], [], ["s1", "s2"]))), [["mcp:s1", "mcp:s2"]]);
});

test("calls with no agent start at the project", () => {
  assert.deepEqual(columns(assertSound(graph([], [], ["s"], [[null, "s"]]))), [
    ["project"],
    ["mcp:s"],
  ]);
});

test("a handoff cycle ends, with every edge drawn", () => {
  const layout = assertSound(
    graph(
      ["a", "b", "c"],
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "a"],
      ],
    ),
  );
  assert.deepEqual(columns(layout), [["agent:a"], ["agent:b"], ["agent:c"]]);
});

test("two agents that hand work to each other", () => {
  assert.equal(
    assertSound(
      graph(
        ["a", "b"],
        [
          ["a", "b"],
          ["b", "a"],
        ],
      ),
    ).edges.length,
    2,
  );
});

test("a capped graph", () => {
  const agents = Array.from({ length: MAX_TOPOLOGY_AGENTS + 4 }, (_, i) => `a${i}`);
  const servers = Array.from({ length: MAX_TOPOLOGY_SERVERS + 4 }, (_, i) => `s${i}`);
  const of = graph(
    agents,
    agents.slice(1).map((key) => ["a0", key]),
    servers,
    servers.map((key) => ["a0", key]),
  );
  assert.deepEqual(of.omitted, { agents: 4, servers: 4, atLeast: false });
  assertSound(of);
});

test("an edge's width follows its count", () => {
  const widths = assertSound(
    graph(
      ["a", "b", "c"],
      [
        ["a", "b"],
        ["a", "c"],
      ],
    ),
  ).edges.map((edge) => edge.width);
  assert.ok(widths[0] > widths[1]);
});
