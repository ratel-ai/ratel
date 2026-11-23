import assert from "node:assert/strict";
import { test } from "node:test";
import { type AgentRollupSpan, agentSubtrees, hasSubAgents } from "./agent-rollup";

/** AOBS-5: each `invoke_agent` span of a run with the totals of its subtree. */

const T0 = Date.parse("2026-11-17T10:00:00.000Z");

function span(
  id: string,
  parent: string | null,
  over: Partial<AgentRollupSpan> = {},
): AgentRollupSpan {
  return {
    spanId: id,
    parentSpanId: parent,
    name: id,
    spanClass: "other",
    operationName: null,
    model: null,
    startedAt: new Date(T0).toISOString(),
    durationMs: 100,
    statusCode: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    attributes: {},
    ...over,
  };
}

const agent = (
  id: string,
  parent: string | null,
  name: string,
  over: Partial<AgentRollupSpan> = {},
) =>
  span(id, parent, {
    name: `invoke_agent ${name}`,
    operationName: "invoke_agent",
    attributes: { "gen_ai.agent.name": name },
    ...over,
  });
const chat = (
  id: string,
  parent: string,
  input: number,
  output: number,
  cost: string | null,
  over: Partial<AgentRollupSpan> = {},
) =>
  span(id, parent, {
    spanClass: "llm_call",
    operationName: "chat",
    model: "claude-opus-5-5",
    inputTokens: input,
    outputTokens: output,
    costUsd: cost,
    ...over,
  });
const tool = (id: string, parent: string, over: Partial<AgentRollupSpan> = {}) =>
  span(id, parent, { spanClass: "tool", operationName: "execute_tool", ...over });

/** root claude > chat > Agent tool > Explore > (chat > Read), and Explore > Agent tool > Plan > chat. */
const RUN: AgentRollupSpan[] = [
  agent("root", null, "claude", { durationMs: 60_000 }),
  chat("c1", "root", 1_000, 200, "0.10"),
  tool("t-agent", "c1", { durationMs: 30_000 }),
  agent("explore", "t-agent", "Explore", {
    durationMs: 29_000,
    model: "claude-haiku-5-5",
    startedAt: new Date(T0 + 1_000).toISOString(),
  }),
  chat("c2", "explore", 500, 100, "0.01", { model: "claude-haiku-5-5" }),
  tool("t-read", "c2", { statusCode: 2 }),
  tool("t-agent2", "c2"),
  agent("plan", "t-agent2", "Plan", {
    durationMs: 5_000,
    startedAt: new Date(T0 + 2_000).toISOString(),
  }),
  chat("c3", "plan", 50, 10, null),
  chat("c4", "root", 2_000, 300, "0.20", { startedAt: new Date(T0 + 40_000).toISOString() }),
];

test("each agent has the tokens, cost and duration of its whole subtree, nested agents included", () => {
  const rows = agentSubtrees(RUN);
  assert.deepEqual(
    rows.map((row) => ({
      name: row.name,
      depth: row.depth,
      parent: row.parentAgentSpanId,
      tokens: row.tokens,
      cost: row.costUsd,
      ms: row.durationMs,
    })),
    [
      { name: "claude", depth: 0, parent: null, tokens: 4_160, cost: 0.31, ms: 60_000 },
      { name: "Explore", depth: 1, parent: "root", tokens: 660, cost: 0.01, ms: 29_000 },
      { name: "Plan", depth: 2, parent: "explore", tokens: 60, cost: 0, ms: 5_000 },
    ],
  );
});

test("an agent counts its model calls, tool calls, failures and unpriced calls", () => {
  const [root, explore, plan] = agentSubtrees(RUN);
  assert.deepEqual([root.modelCalls, root.toolCalls, root.failedSpans], [4, 3, 1]);
  assert.deepEqual([explore.modelCalls, explore.toolCalls, explore.failedSpans], [2, 2, 1]);
  assert.equal(explore.model, "claude-haiku-5-5");
  // A model call with tokens and no cost has no price.
  assert.equal(plan.unpricedCalls, 1);
  assert.equal(root.inputTokens, 3_550);
  assert.equal(root.outputTokens, 610);
});

test("an agent's own share leaves out its nested agents", () => {
  const [root, explore] = agentSubtrees(RUN);
  assert.equal(root.ownTokens, 3_500);
  assert.equal(root.ownCostUsd, 0.3);
  assert.equal(explore.ownTokens, 600);
});

test("a run with no agent span has no rows; an orphan sub-agent is a top row", () => {
  assert.deepEqual(agentSubtrees([span("a", null), chat("b", "a", 1, 1, "0.1")]), []);
  const rows = agentSubtrees([
    agent("explore", "missing-parent", "Explore"),
    chat("c", "explore", 10, 5, null),
  ]);
  assert.deepEqual(
    rows.map((row) => [row.name, row.depth, row.tokens]),
    [["Explore", 0, 15]],
  );
});

test("the agent's name falls back to the span name without its operation", () => {
  const [row] = agentSubtrees([
    span("x", null, { name: "invoke_agent general-purpose", operationName: "invoke_agent" }),
  ]);
  assert.equal(row.name, "general-purpose");
});

test("only a run with a sub-agent is worth the table", () => {
  assert.equal(hasSubAgents(agentSubtrees(RUN)), true);
  assert.equal(
    hasSubAgents(agentSubtrees([agent("root", null, "claude"), chat("c", "root", 1, 1, null)])),
    false,
  );
});

test("a deep chain whose children come before their parents stays quick and does not overflow", () => {
  const depth = 5_000;
  const chain: AgentRollupSpan[] = [];
  for (let index = depth - 1; index >= 0; index -= 1) {
    chain.push(
      agent(`a${index}`, index === 0 ? null : `a${index - 1}`, "nested", {
        startedAt: new Date(T0 + index).toISOString(),
      }),
    );
  }
  const started = Date.now();
  const rows = agentSubtrees(chain);
  assert.equal(rows.length, depth);
  assert.equal(rows.at(-1)?.depth, depth - 1);
  assert.ok(Date.now() - started < 5_000, "the owner walk must not be quadratic");
});
