import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_TOPOLOGY_AGENTS,
  MAX_TOPOLOGY_SERVERS,
  type TopologyRows,
  topologyModel,
} from "./topology";

const agent = (key: string, calls: number, errorRate = 0) => ({
  key,
  displayName: key,
  calls,
  errorRate,
});
const server = (key: string, calls: number, role: "consumed" | "provided" = "consumed") => ({
  key,
  role,
  displayName: key,
  calls,
  errorRate: 0,
});
const rows = (overrides: Partial<TopologyRows> = {}): TopologyRows => ({
  agents: [],
  handoffs: [],
  servers: [],
  calls: [],
  hidden: new Set(),
  names: new Map(),
  ...overrides,
});

test("no row is an empty graph", () => {
  assert.deepEqual(topologyModel(rows()), {
    nodes: [],
    edges: [],
    omitted: { agents: 0, servers: 0, atLeast: false },
  });
});

test("a node fails past the pill rate, not at it", () => {
  const graph = topologyModel(rows({ agents: [agent("a", 10, 0.1), agent("b", 9, 0.11)] }));
  assert.deepEqual(
    graph.nodes.map((node) => node.failing),
    [false, true],
  );
});

test("both roles of a server are one node, with the busier role's calls", () => {
  const graph = topologyModel(
    rows({ servers: [server("board", 4, "provided"), server("board", 7)] }),
  );
  assert.deepEqual(
    graph.nodes.map(({ id, count }) => ({ id, count })),
    [{ id: "mcp:board", count: 7 }],
  );
});

test("calls with no agent come from one project node", () => {
  const graph = topologyModel(
    rows({
      servers: [server("a", 6), server("b", 4)],
      calls: [
        { agent: null, server: "a", calls: 6, errors: 2 },
        { agent: null, server: "b", calls: 4, errors: 0 },
      ],
    }),
  );
  assert.deepEqual(
    graph.nodes.filter((node) => node.kind === "project").map((node) => [node.count, node.failing]),
    [[10, true]],
  );
  assert.deepEqual(graph.edges, [
    { kind: "call", from: "project", to: "mcp:a", count: 6, errors: 2 },
    { kind: "call", from: "project", to: "mcp:b", count: 4, errors: 0 },
  ]);
});

test("an agent seen only at the end of an edge is a node; a hidden one is not", () => {
  const graph = topologyModel(
    rows({
      agents: [agent("secret", 50), agent("main", 5)],
      handoffs: [{ from: "main", to: "sub", fromName: "main", toName: "Sub", count: 2 }],
      servers: [server("s", 9)],
      calls: [{ agent: "secret", server: "s", calls: 9, errors: 0 }],
      hidden: new Set(["secret"]),
    }),
  );
  assert.deepEqual(
    graph.nodes.map((node) => node.name),
    ["main", "Sub", "s"],
  );
  assert.deepEqual(
    graph.edges.map((edge) => edge.kind),
    ["handoff"],
  );
});

test("an agent and a server with one key stay two nodes", () => {
  const graph = topologyModel(rows({ agents: [agent("x", 1)], servers: [server("x", 1)] }));
  assert.deepEqual(
    graph.nodes.map((node) => node.id),
    ["agent:x", "mcp:x"],
  );
});

test("the caps keep the busiest nodes and report the rest as counts", () => {
  const graph = topologyModel(
    rows({
      agents: Array.from({ length: MAX_TOPOLOGY_AGENTS + 3 }, (_, i) => agent(`a${i}`, i)),
      servers: Array.from({ length: MAX_TOPOLOGY_SERVERS + 2 }, (_, i) => server(`s${i}`, i)),
      calls: [{ agent: "a0", server: "s9", calls: 1, errors: 0 }],
    }),
  );
  assert.equal(graph.nodes.length, MAX_TOPOLOGY_AGENTS + MAX_TOPOLOGY_SERVERS);
  assert.equal(graph.nodes[0].key, `a${MAX_TOPOLOGY_AGENTS + 2}`);
  assert.deepEqual(graph.omitted, { agents: 3, servers: 2, atLeast: false });
  assert.deepEqual(graph.edges, [], "no edge to a node left out");
});

test("a read at its limit makes the rest a lower bound", () => {
  const agents = Array.from({ length: 200 }, (_, i) => agent(`a${i}`, i));
  assert.equal(topologyModel(rows({ agents })).omitted.atLeast, true);
});
