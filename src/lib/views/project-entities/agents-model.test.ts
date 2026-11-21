import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AgentListEntry,
  type AgentToolEntry,
  agentErrorPill,
  agentTree,
  groupAgentTools,
  type Handoff,
  handoffChain,
  handoffMapLayout,
  sortAgentRows,
} from "./agents-model";

/** RP-28: the Agents pages' tree, sort, pill, tool groups and map (the approved RP-25 design). */

const agent = (
  key: string,
  calls: number,
  extra: Partial<AgentListEntry> = {},
): AgentListEntry => ({
  key,
  displayName: key,
  calls,
  errors: 0,
  errorRate: 0,
  costUsd: 0,
  p95Ms: 0,
  lastSeenAt: "2026-11-21T10:00:00.000Z",
  ...extra,
});
const edge = (from: string, to: string, count: number): Handoff => ({
  from,
  to,
  fromName: from,
  toName: to,
  count,
});

const CLAUDE = agent("claude", 12, { errors: 5, errorRate: 5 / 12, costUsd: 5.77 });
const EXPLORE = agent("Explore", 8, { costUsd: 0.01 });
const PLAN = agent("Plan", 4, { costUsd: 0.03 });
const SOLO = agent("solo", 20);

test("the tree nests each agent under its caller, entry agents first, with roles and the from line", () => {
  const tree = agentTree(
    [PLAN, EXPLORE, CLAUDE],
    [edge("claude", "Explore", 8), edge("Explore", "Plan", 4)],
  );
  assert.deepEqual(
    tree.map(({ agent: { key }, depth, role, parent, callees }) => ({
      key,
      depth,
      role,
      parent,
      callees,
    })),
    [
      { key: "claude", depth: 0, role: "entry", parent: null, callees: ["Explore"] },
      {
        key: "Explore",
        depth: 1,
        role: "sub-agent",
        parent: { key: "claude", name: "claude", count: 8 },
        callees: ["Plan"],
      },
      {
        key: "Plan",
        depth: 2,
        role: "sub-agent",
        parent: { key: "Explore", name: "Explore", count: 4 },
        callees: [],
      },
    ],
  );
});

test("an agent with two callers nests under the busier one; a loop does not nest", () => {
  const tree = agentTree(
    [agent("a", 10), agent("b", 9), agent("c", 3)],
    [edge("a", "c", 1), edge("b", "c", 5), edge("a", "b", 2), edge("b", "a", 1)],
  );
  assert.deepEqual(
    tree.map((row) => [row.agent.key, row.depth, row.parent?.key ?? null]),
    [
      ["a", 0, null],
      ["b", 1, "a"],
      ["c", 2, "b"],
    ],
  );
  assert.equal(tree[0].role, "sub-agent", "a is called by b, so it is not an entry agent");
});

test("with no handoff every agent is a flat row with no role", () => {
  const tree = agentTree([EXPLORE, SOLO], []);
  assert.deepEqual(
    tree.map((row) => [row.agent.key, row.depth, row.role]),
    [
      ["solo", 0, null],
      ["Explore", 0, null],
    ],
  );
});

test("a handoff to an agent outside the list does not nest or count", () => {
  const tree = agentTree([CLAUDE], [edge("claude", "hidden", 3)]);
  assert.deepEqual(
    tree.map((row) => [row.agent.key, row.role, row.callees]),
    [["claude", null, []]],
  );
});

test("no sort keeps the tree; a sort by a column flattens it", () => {
  const tree = agentTree(
    [PLAN, EXPLORE, CLAUDE],
    [edge("claude", "Explore", 8), edge("Explore", "Plan", 4)],
  );
  assert.deepEqual(
    sortAgentRows(tree, null).map((row) => [row.agent.key, row.depth]),
    [
      ["claude", 0],
      ["Explore", 1],
      ["Plan", 2],
    ],
  );
  assert.deepEqual(
    sortAgentRows(tree, { id: "cost", direction: "asc" }).map((row) => [row.agent.key, row.depth]),
    [
      ["Explore", 0],
      ["Plan", 0],
      ["claude", 0],
    ],
  );
  assert.deepEqual(
    sortAgentRows(tree, { id: "name", direction: "desc" }).map((row) => row.agent.key),
    ["Plan", "Explore", "claude"],
  );
});

test("the error pill shows above 10%, not at it", () => {
  assert.equal(agentErrorPill(0.42), true);
  assert.equal(agentErrorPill(0.1), false);
  assert.equal(agentErrorPill(0), false);
});

test("the handoff chain is the deepest path of the tree; one agent has none", () => {
  const tree = agentTree(
    [PLAN, EXPLORE, CLAUDE],
    [edge("claude", "Explore", 8), edge("Explore", "Plan", 4)],
  );
  assert.deepEqual(handoffChain(tree), ["claude", "Explore", "Plan"]);
  assert.deepEqual(handoffChain(agentTree([SOLO], [])), []);
});

test("tools group by MCP server, busiest first, then built-in with the quiet tail folded", () => {
  const tool = (
    name: string,
    server: string | null,
    calls: number,
    errors = 0,
  ): AgentToolEntry => ({
    tool: name,
    server,
    calls,
    errors,
    errorRate: calls ? errors / calls : 0,
    p95Ms: calls * 10,
    lastError: errors ? "timeout" : null,
  });
  const groups = groupAgentTools(
    [
      tool("send_message", "slack", 2, 2),
      tool("task_update", "beluga_board", 15, 3),
      tool("task_get", "beluga_board", 12),
      tool("Bash:git", null, 27),
      tool("Bash:pnpm", null, 15, 3),
      tool("Edit", null, 12),
      tool("Read", null, 12),
      tool("Write", null, 12),
      tool("Skill", null, 6),
      tool("Agent", null, 8),
      tool("Bash:gh", null, 4),
    ],
    3,
  );
  assert.deepEqual(
    groups.map((group) => [group.server, group.calls, group.errors]),
    [
      ["beluga_board", 27, 3],
      ["slack", 2, 2],
      [null, 96, 3],
    ],
  );
  const builtIn = groups[2].rows;
  assert.deepEqual(
    builtIn.map((row) => (row.kind === "tool" ? row.tool.tool : row.tools)),
    ["Bash:git", "Bash:pnpm", "Edit", ["Read", "Write", "Agent", "Skill", "Bash:gh"]],
  );
  const folded = builtIn[3];
  assert.ok(folded.kind === "folded");
  assert.equal(folded.calls, 42);
  assert.equal(folded.p95Ms, 120);
});

test("one tool past the cap is shown, not folded", () => {
  const tool = (name: string, calls: number): AgentToolEntry => ({
    tool: name,
    server: null,
    calls,
    errors: 0,
    errorRate: 0,
    p95Ms: 1,
    lastError: null,
  });
  const [group] = groupAgentTools([tool("a", 3), tool("b", 2)], 1);
  assert.deepEqual(
    group.rows.map((row) => row.kind),
    ["tool", "tool"],
  );
});

test("the map lays agents left to right by depth, sizes boxes by runs and edges by handoffs, and marks failing agents", () => {
  const handoffs = [edge("claude", "Explore", 8), edge("Explore", "Plan", 4)];
  const tree = agentTree([PLAN, EXPLORE, CLAUDE, SOLO], handoffs);
  const map = handoffMapLayout(tree, handoffs);
  assert.deepEqual(
    map.nodes.map((node) => node.key),
    ["claude", "Explore", "Plan"],
    "an agent with no handoff is not drawn",
  );
  const [claude, explore, plan] = map.nodes;
  assert.ok(claude.x < explore.x && explore.x < plan.x);
  assert.ok(claude.width > explore.width && explore.width > plan.width);
  assert.equal(claude.failing, true);
  assert.equal(explore.failing, false);
  assert.deepEqual(
    map.edges.map((each) => [each.from, each.to, each.width]),
    [
      ["claude", "Explore", 6],
      ["Explore", "Plan", 3.5],
    ],
  );
  assert.ok(map.width >= plan.x + plan.width);
});

test("the map is empty with no handoff", () => {
  assert.deepEqual(handoffMapLayout(agentTree([SOLO], []), []), {
    nodes: [],
    edges: [],
    width: 0,
    height: 0,
  });
});
