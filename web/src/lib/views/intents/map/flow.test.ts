import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFlowData,
  FLOW_MAX_ASKS,
  FLOW_MAX_CAPABILITIES,
  FLOWS_PER_ASK,
  flowNodeName,
  flowTints,
  MIN_FLOW_SHARE,
  OTHER_ASKS,
  OTHER_CAPABILITIES,
} from "@/lib/views/intents/map/flow";
import type { IntentMapModel } from "@/lib/views/intents/map/map-model";

function model(): IntentMapModel {
  const ask = (id: string, label: string, volume: number) => ({
    id,
    label,
    volume,
    phrasings: 1,
    firstTry: null,
    rankedByGraph: 0,
    problem: null,
  });
  const capability = (name: string, calls: number, asks: number) => ({
    id: `tool:${name}`,
    kind: "tool" as const,
    name,
    calls,
    asks,
    missing: false,
  });
  const link = (askId: string, name: string, weight: number) => ({
    ask: askId,
    capability: `tool:${name}`,
    weight,
    share: 0,
  });
  return {
    asks: [
      ask("a", "Create a task", 70),
      ask("b", "Search the codebase", 62),
      ask("c", "Find an order", 46),
      ask("d", "Refund a charge", 14),
    ],
    capabilities: [
      capability("acme_create_task", 62, 1),
      capability("ripgrep", 57, 1),
      capability("lookup_order", 41, 1),
      capability("stripe_refund_charge", 12, 1),
      capability("linear_create_issue", 8, 1),
      capability("github_api", 5, 1),
      capability("stripe_list_invoices", 5, 1),
      capability("stripe_get_customer", 2, 1),
    ],
    links: [
      link("a", "acme_create_task", 62),
      link("a", "linear_create_issue", 8),
      link("b", "ripgrep", 57),
      link("b", "github_api", 5),
      link("c", "lookup_order", 41),
      link("c", "stripe_list_invoices", 5),
      link("d", "stripe_refund_charge", 12),
      link("d", "stripe_get_customer", 2),
    ],
    hidden: null,
  };
}

test("every ask and capability gets a row when they fit, and calls are conserved", () => {
  const flow = buildFlowData(model());
  const left = flow.nodes.filter((node) => node.side === "ask");
  const right = flow.nodes.filter((node) => node.side === "capability");
  assert.equal(left.length, 4);
  assert.equal(right.length, 8);
  assert.equal(flow.total, 192);
  const sum = (nodes: typeof left) => nodes.reduce((total, node) => total + node.value, 0);
  assert.equal(sum(left), flow.total);
  assert.equal(sum(right), flow.total);
  assert.deepEqual(
    left.map((node) => node.label),
    ["Create a task", "Search the codebase", "Find an order", "Refund a charge"],
  );
});

test("the right column follows the left, so ribbons barely cross", () => {
  const right = buildFlowData(model()).nodes.filter((node) => node.side === "capability");
  assert.deepEqual(
    right.map((node) => node.label),
    [
      "acme_create_task",
      "linear_create_issue",
      "ripgrep",
      "github_api",
      "lookup_order",
      "stripe_list_invoices",
      "stripe_refund_charge",
      "stripe_get_customer",
    ],
  );
});

test("past the limits the quietest rows fold into one Other row per side", () => {
  const flow = buildFlowData(model(), { asks: 3, capabilities: 4 });
  const left = flow.nodes.filter((node) => node.side === "ask");
  const right = flow.nodes.filter((node) => node.side === "capability");
  assert.equal(left.length, 3);
  assert.deepEqual(left[2], {
    id: OTHER_ASKS,
    side: "ask",
    label: "2 other intents",
    ref: null,
    kind: null,
    value: 60,
    folded: 2,
    tint: null,
  });
  assert.equal(right.length, 4);
  assert.equal(right.at(-1)?.id, OTHER_CAPABILITIES);
  assert.equal(right.at(-1)?.label, "5 other tools");
  assert.equal(flow.total, 192, "folding never loses calls");
  const keys = flow.links.map((link) => `${link.source}|${link.target}`);
  assert.equal(new Set(keys).size, keys.length, "one ribbon per pair of rows");
});

test("an empty model has nothing to draw", () => {
  const flow = buildFlowData({ asks: [], capabilities: [], links: [], hidden: null });
  assert.deepEqual(flow, { nodes: [], links: [], total: 0 });
});

test("rows are named by id, tool name or what they fold, never by an ask's label", () => {
  const flow = buildFlowData(model(), { asks: 2, capabilities: 3 });
  const names = flow.nodes.map(flowNodeName);
  assert.ok(names.includes("Intent a: 70 calls"));
  assert.ok(names.includes("acme_create_task: 62 calls"));
  assert.ok(names.some((name) => /^\d+ other intents: \d+ calls$/.test(name)));
  for (const label of [
    "Create a task",
    "Search the codebase",
    "Find an order",
    "Refund a charge",
  ]) {
    assert.ok(
      names.every((name) => !name.includes(label)),
      `no label in a name: ${label}`,
    );
  }
});

test("only the top items get a row: eight intents and ten tools at most, the rest in Other", () => {
  assert.equal(FLOW_MAX_ASKS, 8);
  assert.equal(FLOW_MAX_CAPABILITIES, 10);
  const asks = Array.from({ length: 12 }, (_, index) => ({
    id: `i${index}`,
    label: `Intent ${index}`,
    volume: 100 - index,
    phrasings: 1,
    firstTry: null,
    rankedByGraph: 0,
    problem: null,
  }));
  const capabilities = Array.from({ length: 14 }, (_, index) => ({
    id: `tool:t${index}`,
    kind: "tool" as const,
    name: `t${index}`,
    calls: 0,
    asks: 1,
    missing: false,
  }));
  // Each intent leans on one tool of its own, so every tool is some intent's main tool.
  const links = asks.flatMap((ask, index) => [
    { ask: ask.id, capability: `tool:t${index}`, weight: 50 - index, share: 0 },
    { ask: ask.id, capability: `tool:t${(index + 12) % 14}`, weight: 10, share: 0 },
  ]);
  const flow = buildFlowData({ asks, capabilities, links, hidden: null });
  assert.equal(flow.nodes.filter((node) => node.side === "ask").length, 8);
  assert.equal(flow.nodes.filter((node) => node.side === "capability").length, 10);
  assert.equal(
    flow.total,
    links.reduce((sum, link) => sum + link.weight, 0),
    "folding never loses calls",
  );
});

test("each intent keeps ribbons to its few main tools; its trickles run into Other", () => {
  assert.equal(FLOWS_PER_ASK, 4);
  assert.equal(MIN_FLOW_SHARE, 0.05);
  const ask = {
    id: "a",
    label: "Schedule status",
    volume: 300,
    phrasings: 1,
    firstTry: null,
    rankedByGraph: 0,
    problem: null,
  };
  const tool = (name: string) => ({
    id: `tool:${name}`,
    kind: "tool" as const,
    name,
    calls: 0,
    asks: 1,
    missing: false,
  });
  const flow = buildFlowData({
    asks: [ask],
    capabilities: ["schedule", "weather", "projects", "orders", "pay"].map(tool),
    links: [
      { ask: "a", capability: "tool:schedule", weight: 243, share: 0 },
      { ask: "a", capability: "tool:weather", weight: 118, share: 0 },
      { ask: "a", capability: "tool:projects", weight: 13, share: 0 },
      { ask: "a", capability: "tool:orders", weight: 5, share: 0 },
      { ask: "a", capability: "tool:pay", weight: 1, share: 0 },
    ],
    hidden: null,
  });
  const right = flow.nodes.filter((node) => node.side === "capability");
  assert.deepEqual(
    right.map((node) => [node.label, node.value]),
    [
      ["schedule", 243],
      ["weather", 118],
      ["3 other tools", 19],
    ],
    "under 5% of the intent's calls is a trickle",
  );
  assert.equal(flow.total, 380);
});

test("rows and ribbons wear their task's color: intents grouped by main task, colored tasks first; a ribbon takes its tool's", () => {
  const ask = (id: string, volume: number, tint: "chart-1" | "chart-5" | null) => ({
    id,
    label: id,
    volume,
    phrasings: 1,
    firstTry: null,
    rankedByGraph: 0,
    problem: null,
    tint,
  });
  const tool = (name: string, tint: "chart-1" | "chart-5" | null) => ({
    id: `tool:${name}`,
    kind: "tool" as const,
    name,
    calls: 0,
    asks: 1,
    missing: false,
    tint,
  });
  const flow = buildFlowData({
    asks: [ask("busy", 90, null), ask("delivery", 50, "chart-1"), ask("spec", 40, "chart-5")],
    capabilities: [tool("schedule", null), tool("track", "chart-1"), tool("spec_book", "chart-5")],
    links: [
      { ask: "busy", capability: "tool:schedule", weight: 90, share: 0 },
      { ask: "delivery", capability: "tool:track", weight: 50, share: 0 },
      { ask: "spec", capability: "tool:spec_book", weight: 40, share: 0 },
    ],
    hidden: null,
  });
  const left = flow.nodes.filter((node) => node.side === "ask");
  assert.deepEqual(
    left.map((node) => [node.ref, node.tint]),
    [
      ["delivery", "chart-1"],
      ["spec", "chart-5"],
      ["busy", null],
    ],
  );
  assert.deepEqual(
    flow.links.map((link) => [link.target, link.tint]),
    [
      ["capability:tool:track", "chart-1"],
      ["capability:tool:spec_book", "chart-5"],
      ["capability:tool:schedule", null],
    ],
  );
  assert.deepEqual(flowTints(flow), ["chart-1", "chart-5"]);
});
