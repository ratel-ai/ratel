import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BACKBONE_K,
  buildToolNetwork,
  explorerCapabilityKey,
  GROUP_COLORS,
  linkReasons,
  MAX_GROUP_SIZE,
  networkLayoutKey,
  networkNeighbours,
  networkNodeName,
  STRENGTH_FLOOR,
  type ToolNetworkModel,
  type ToolStep,
  toolStepsFromEdges,
} from "@/lib/views/intents/map/tool-network";
import { mapModelFrom as mapModel } from "@/lib/views/intents/map/tool-network-fixture";

const link = (network: ToolNetworkModel, a: string, b: string) =>
  network.links.find(
    (item) =>
      (item.source === `tool:${a}` && item.target === `tool:${b}`) ||
      (item.source === `tool:${b}` && item.target === `tool:${a}`),
  );
const node = (network: ToolNetworkModel, id: string) =>
  network.nodes.find((item) => item.id === `tool:${id}`)!;

test("two tools are linked when they answer the same ask groups, and the link keeps which, busiest first", () => {
  const network = buildToolNetwork({
    model: mapModel([
      ["search", "ripgrep", 50],
      ["search", "github", 10],
      ["usages", "ripgrep", 20],
      ["usages", "github", 5],
      ["orders", "lookup_order", 30],
    ]),
  });
  const pair = link(network, "github", "ripgrep")!;
  assert.deepEqual(pair.shared, ["search", "usages"], "the busier group first");
  assert.equal(pair.directed, false, "sharing groups says nothing about order");
  assert.ok(pair.strength > 0 && pair.strength <= 1);
  assert.equal(link(network, "lookup_order", "ripgrep"), undefined, "no shared group, no link");
  assert.equal(node(network, "lookup_order").partners, 0);
  assert.equal(node(network, "ripgrep").partners, 1);
});

test("each tool keeps its strongest few links at rest, plus any strong in its own right; the rest wait for a hover", () => {
  // Six tools that all answer one group: fifteen pairs, every one as strong as the next.
  const crowd = ["a", "b", "c", "d", "e", "f"].map((tool, index): [string, string, number] => [
    "crowd",
    tool,
    60 - index * 10,
  ]);
  // Two that answer the same two groups and nothing else: strong enough to keep on its own.
  const pair: Array<[string, string, number]> = [
    ["deploy", "promote", 10],
    ["deploy", "flaky", 8],
    ["rollback", "promote", 4],
    ["rollback", "flaky", 4],
  ];
  const network = buildToolNetwork({ model: mapModel([...crowd, ...pair]) });
  const crowdLinks = network.links.filter((item) => item.shared.includes("crowd"));
  assert.equal(crowdLinks.length, 15, "every pair is known");
  const kept = crowdLinks.filter((item) => item.backbone);
  assert.ok(kept.length < crowdLinks.length, "never the whole clique at rest");
  for (const tool of ["a", "b", "c", "d", "e", "f"]) {
    const own = kept.filter(
      (item) => item.source === `tool:${tool}` || item.target === `tool:${tool}`,
    );
    assert.ok(
      own.length >= Math.min(BACKBONE_K, 5),
      `${tool} keeps at least its strongest ${BACKBONE_K}`,
    );
  }
  assert.ok(
    kept.some((item) => item.id === "tool:a|tool:b"),
    "ties go to the busiest partners",
  );
  assert.equal(
    kept.some((item) => item.id === "tool:e|tool:f"),
    false,
    "the two quietest do not link each other",
  );
  const strong = link(network, "flaky", "promote")!;
  assert.ok(strong.strength >= STRENGTH_FLOOR, "two groups and nothing else is strong");
  assert.equal(strong.backbone, true);
  assert.deepEqual(
    [...networkNeighbours(network, "tool:f")].sort(),
    ["tool:a", "tool:b", "tool:c", "tool:d", "tool:e", "tool:f"],
    "a hover lights every partner, hidden links included",
  );
});

test("a tool serving four or more groups is a hub: flagged, neutral, and never glues groups together", () => {
  const rows: Array<[string, string, number]> = [];
  for (const [index, ask] of ["pr", "ci", "branch", "issues"].entries()) {
    rows.push([ask, "github", 20 - index], [ask, `${ask}_one`, 10], [ask, `${ask}_two`, 6]);
  }
  const network = buildToolNetwork({ model: mapModel(rows) });
  const hub = node(network, "github");
  assert.equal(hub.hub, true);
  assert.equal(hub.group, null, "a hub belongs to no group");
  assert.equal(
    network.groups.length,
    4,
    "without the hub, each ask's own tools are a group of their own",
  );
  for (const group of network.groups) assert.equal(group.members.length, 2);
  assert.equal(network.nodes.filter((item) => item.hub).length, 1, "only the hub");
});

test("a tool linked to many tools beyond its own groups is a hub too", () => {
  const model = mapModel([
    ["search", "search_docs", 40],
    ["search", "grep", 10],
    ...["a", "b", "c", "d", "e"].map((tool): [string, string, number] => [`ask_${tool}`, tool, 8]),
  ]);
  const steps: ToolStep[] = ["a", "b", "c", "d", "e"].map((tool) => ({
    from: "tool:search_docs",
    to: `tool:${tool}`,
    n: 6,
    of: 40,
  }));
  const network = buildToolNetwork({ model, steps });
  assert.equal(node(network, "search_docs").partners, 6);
  assert.equal(node(network, "search_docs").hub, true, "five partners beyond its one group's one");
  assert.equal(node(network, "grep").hub, false);
  // Six tools all answering one group are linked to five each, all from that group: not hubs.
  const crowd = buildToolNetwork({
    model: mapModel(
      ["a", "b", "c", "d", "e", "f"].map((tool): [string, string, number] => ["crowd", tool, 5]),
    ),
  });
  assert.equal(
    crowd.nodes.some((item) => item.hub),
    false,
    "partners its own group explains do not count",
  );
});

test("groups are the backbone's connected parts without hubs, and one never grows past the cap", () => {
  // A long chain of tools, each sharing one group with the next.
  const chain = Array.from({ length: 16 }, (_, index) => `t${String(index).padStart(2, "0")}`);
  const rows: Array<[string, string, number]> = [];
  for (let index = 0; index + 1 < chain.length; index += 1) {
    rows.push([`link_${index}`, chain[index]!, 10], [`link_${index}`, chain[index + 1]!, 10]);
  }
  const network = buildToolNetwork({ model: mapModel(rows) });
  assert.equal(
    network.nodes.some((item) => item.hub),
    false,
  );
  assert.ok(network.groups.length >= 2, "a chain longer than the cap splits");
  for (const group of network.groups)
    assert.ok(group.members.length <= MAX_GROUP_SIZE, `${group.id} stays within the cap`);
  const grouped = network.groups.flatMap((group) => group.members);
  assert.equal(new Set(grouped).size, grouped.length, "a tool is in one group at most");
  for (const group of network.groups) {
    for (const member of group.members)
      assert.equal(network.nodes.find((item) => item.id === member)!.group, group.id);
  }
});

test("at most three groups wear a hue, blue, magenta, then yellow, biggest first; every other group is neutral", () => {
  const rows: Array<[string, string, number]> = [];
  const sizes = [2, 5, 3, 2, 4];
  sizes.forEach((size, group) => {
    for (let index = 0; index < size; index += 1)
      rows.push([`ask_${group}`, `g${group}_t${index}`, 10 + group]);
  });
  const network = buildToolNetwork({ model: mapModel(rows) });
  assert.equal(network.groups.length, 5);
  assert.deepEqual(
    network.groups.map((group) => group.members.length),
    [5, 4, 3, 2, 2],
    "biggest first",
  );
  assert.deepEqual(
    network.groups.map((group) => group.color),
    [...GROUP_COLORS, null, null],
  );
  assert.deepEqual([...GROUP_COLORS], ["chart-1", "chart-5", "chart-4"]);
  assert.equal(
    network.groups[3]!.members[0],
    "tool:g3_t0",
    "a tie in size goes to the busier group",
  );
  // Keyboard order walks group by group, then the rest.
  assert.deepEqual(
    network.nodes.slice(0, 5).map((item) => item.group),
    ["g1", "g1", "g1", "g1", "g1"],
  );
});

test("came next counts link tools in order: one-way only when one direction clearly wins", () => {
  const model = mapModel([
    ["orders", "lookup_order", 40],
    ["orders", "list_invoices", 10],
    ["refunds", "refund_charge", 12],
    ["customers", "get_customer", 14],
  ]);
  const steps: ToolStep[] = [
    { from: "tool:lookup_order", to: "tool:refund_charge", n: 12, of: 30 },
    { from: "tool:refund_charge", to: "tool:lookup_order", n: 2, of: 12 },
    { from: "tool:get_customer", to: "tool:refund_charge", n: 5, of: 14 },
    { from: "tool:refund_charge", to: "tool:get_customer", n: 4, of: 12 },
    { from: "tool:lookup_order", to: "tool:list_invoices", n: 1, of: 30 },
    { from: "tool:lookup_order", to: "tool:not_on_the_map", n: 9, of: 30 },
  ];
  const network = buildToolNetwork({ model, steps });
  const oneWay = link(network, "lookup_order", "refund_charge")!;
  assert.equal(oneWay.directed, true);
  assert.equal(oneWay.source, "tool:lookup_order", "drawn from the tool that runs first");
  assert.deepEqual(oneWay.shared, [], "a step links tools that share no group");
  assert.equal(oneWay.steps[0]!.from, "tool:lookup_order", "the usual order first");
  const bothWays = link(network, "get_customer", "refund_charge")!;
  assert.equal(bothWays.directed, false, "five against four is no order");
  const invoices = link(network, "list_invoices", "lookup_order")!;
  assert.deepEqual(invoices.steps, [], "a count under the minimum is noise");
  assert.equal(
    network.links.some((item) => item.id.includes("not_on_the_map")),
    false,
    "only tools on the map",
  );
});

test("the same input gives the same model, whatever order it arrives in", () => {
  const rows: Array<[string, string, number]> = [
    ["a", "one", 30],
    ["a", "two", 20],
    ["b", "two", 12],
    ["b", "three", 12],
    ["c", "four", 9],
    ["c", "five", 9],
    ["d", "hub", 4],
    ["e", "hub", 4],
    ["f", "hub", 4],
    ["g", "hub", 4],
    ["d", "six", 3],
  ];
  const steps: ToolStep[] = [
    { from: "tool:one", to: "tool:four", n: 6, of: 20 },
    { from: "tool:five", to: "tool:three", n: 3, of: 9 },
  ];
  const first = buildToolNetwork({ model: mapModel(rows), steps });
  const shuffled = mapModel([...rows].reverse());
  const second = buildToolNetwork({
    model: {
      ...shuffled,
      asks: [...shuffled.asks].reverse(),
      capabilities: [...shuffled.capabilities].reverse(),
    },
    steps: [...steps].reverse(),
  });
  assert.deepEqual(second, first);
  assert.equal(networkLayoutKey(second), networkLayoutKey(first));
  assert.deepEqual(buildToolNetwork({ model: mapModel(rows), steps }), first, "and again");
});

test("the drawing is laid out again only when what it draws moves", () => {
  const model = mapModel([
    ["a", "one", 30],
    ["a", "two", 20],
  ]);
  const network = buildToolNetwork({ model });
  const renamed = buildToolNetwork({
    model: { ...model, asks: model.asks.map((ask) => ({ ...ask, label: "renamed" })) },
  });
  assert.equal(
    networkLayoutKey(renamed),
    networkLayoutKey(network),
    "a renamed group keeps the drawing",
  );
  const busier = buildToolNetwork({
    model: mapModel([
      ["a", "one", 90],
      ["a", "two", 20],
    ]),
  });
  assert.notEqual(networkLayoutKey(busier), networkLayoutKey(network));
});

test("Tool Explorer ids map onto the map's keys, and only steps between tools on the map are kept", () => {
  assert.equal(explorerCapabilityKey("lookup_order"), "tool:lookup_order");
  assert.equal(explorerCapabilityKey("skill:review-pull-request"), "skill:review-pull-request");
  const keep = new Set(["tool:lookup_order", "tool:refund_charge", "skill:review-pull-request"]);
  assert.deepEqual(
    toolStepsFromEdges(
      [
        { a: "lookup_order", b: "refund_charge", n: 12, nA: 30 },
        { a: "lookup_order", b: "skill:review-pull-request", n: 3, nA: 30 },
        { a: "lookup_order", b: "gone", n: 7, nA: 30 },
        { a: "lookup_order", b: "lookup_order", n: 4, nA: 30 },
      ],
      keep,
    ),
    [
      { from: "tool:lookup_order", to: "tool:refund_charge", n: 12, of: 30 },
      { from: "tool:lookup_order", to: "skill:review-pull-request", n: 3, of: 30 },
    ],
  );
});

test("why two tools are linked, in words: labels as text, counted past three; names carry no labels", () => {
  const reasons = linkReasons(
    {
      shared: ["a", "b", "c", "d", "e"],
      steps: [{ from: "tool:one", to: "tool:two", n: 12, of: 30 }],
    },
    (id) => id.slice(5),
    (ask) => (ask === "e" ? null : `where is order ${ask}?`),
  );
  assert.deepEqual(reasons, [
    "Both serve 5 of the same intents: where is order a?; where is order b?; where is order c?; and 2 more.",
    "two came next after one in 12 of 30 calls.",
  ]);
  assert.deepEqual(
    linkReasons(
      { shared: ["a"], steps: [] },
      (id) => id,
      () => "create a task",
    ),
    ["Both serve the same intent: create a task."],
  );
  const network = buildToolNetwork({
    model: mapModel(
      [
        ["a", "one", 30],
        ["a", "two", 20],
      ],
      ["tool:two"],
    ),
  });
  assert.equal(
    networkNodeName(node(network, "two")),
    "two, tool: 20 calls across 1 intent, linked to 1 tool, not in your catalog",
  );
  assert.equal(
    networkNodeName(node(network, "two"), "shared"),
    "two, tool: 20 calls across 1 intent, linked to 1 tool, shared by many tasks, not in your catalog",
  );
  assert.equal(
    networkNodeName(node(network, "two"), "other"),
    "two, tool: 20 calls across 1 intent, linked to 1 tool, in no task, not in your catalog",
  );
  for (const reason of reasons) assert.doesNotMatch(reason, /\u2014/, "no em dashes");
});
