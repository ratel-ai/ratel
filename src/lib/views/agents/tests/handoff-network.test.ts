import assert from "node:assert/strict";
import { test } from "node:test";
import * as force from "d3-force";
import { settleNetwork } from "@/lib/views/intents/map/tool-network-layout";
import { handoffNetwork } from "../domain/handoff-network";

const AGENTS = [
  { key: "supervisor", name: "supervisor", runs: 10 },
  { key: "researcher", name: "researcher", runs: 8 },
  { key: "writer", name: "writer", runs: 3 },
  { key: "loner", name: "loner", runs: 1 },
];
const HANDOFFS = [
  { from: "supervisor", to: "writer", fromName: "supervisor", toName: "writer", count: 3 },
  { from: "supervisor", to: "researcher", fromName: "supervisor", toName: "researcher", count: 8 },
];

test("one mark per agent sized by runs, one directed link per handoff, strongest first", () => {
  const { network, handoffs } = handoffNetwork(AGENTS, HANDOFFS);
  assert.deepEqual(
    network.nodes.map((node) => [node.id, node.calls, node.partners]),
    [
      ["supervisor", 10, 2],
      ["researcher", 8, 1],
      ["writer", 3, 1],
      ["loner", 1, 0],
    ],
  );
  assert.deepEqual(
    network.links.map((link) => [
      link.id,
      link.source,
      link.target,
      link.directed,
      link.backbone,
      link.strength,
    ]),
    [
      ["supervisor|researcher", "supervisor", "researcher", true, true, 1],
      ["supervisor|writer", "supervisor", "writer", true, true, 3 / 8],
    ],
  );
  assert.deepEqual(handoffs.get("supervisor|writer"), {
    from: "supervisor",
    to: "writer",
    fromName: "supervisor",
    toName: "writer",
    count: 3,
  });
  assert.deepEqual(network.groups, []);
});

test("a rare handoff keeps a strength floor, and an agent seen only in a handoff still gets a mark", () => {
  const { network } = handoffNetwork(AGENTS.slice(0, 1), [
    { from: "supervisor", to: "ghost", fromName: "supervisor", toName: "Ghost", count: 1 },
    {
      from: "supervisor",
      to: "researcher",
      fromName: "supervisor",
      toName: "researcher",
      count: 100,
    },
  ]);
  assert.equal(network.links.find((link) => link.target === "ghost")?.strength, 0.3);
  assert.deepEqual(
    network.nodes.find((node) => node.id === "ghost"),
    {
      id: "ghost",
      kind: "tool",
      name: "Ghost",
      calls: 0,
      asks: 0,
      missing: false,
      partners: 1,
      hub: false,
      group: null,
    },
  );
});

test("the tool network layout settles the handoff graph: every agent placed, the same every time", () => {
  const { network } = handoffNetwork(AGENTS, HANDOFFS);
  const first = settleNetwork(force, network, { width: 720, height: 360 });
  const second = settleNetwork(force, network, { width: 720, height: 360 });
  assert.deepEqual([...first.keys()].sort(), ["loner", "researcher", "supervisor", "writer"]);
  assert.deepEqual([...first.entries()], [...second.entries()]);
});
