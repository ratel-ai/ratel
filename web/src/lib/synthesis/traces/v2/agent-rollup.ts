/**
 * A run's agents (AOBS-5): each `invoke_agent` span
 * with what its whole subtree spent. A coding agent hands work to sub-agents
 * (`execute_tool Agent` > `invoke_agent Explore` > its model and tool calls),
 * and a sub-agent can do the same, so the rows nest. Built from the run's
 * spans, as the run summary is, so it needs no stored rollup.
 */

import { isUnpricedCall } from "./cost-label";
import { humanSpanName, stepKind, stringAttribute } from "./span-kind";

/** The span fields the rollup reads: a subset of both `OtelSpan` and `TraceSpanView`. */
export interface AgentRollupSpan {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  spanClass: string;
  operationName: string | null;
  model: string | null;
  startedAt: Date | string;
  durationMs: number;
  statusCode: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: string | number | null;
  attributes: Readonly<Record<string, unknown>>;
}

export interface AgentSubtree {
  /** The `invoke_agent` span. */
  spanId: string;
  /** The nearest agent above it, or null for a top agent. */
  parentAgentSpanId: string | null;
  /** 0 for a top agent, 1 for its sub-agents, and so on. */
  depth: number;
  /** `gen_ai.agent.name`: the runtime for the main agent, the type for a sub-agent. */
  name: string;
  /** The agent span's own model, else the model of its first model call. */
  model: string | null;
  /** The agent span's own duration: its subtree runs inside it. */
  durationMs: number;
  /** Totals of the whole subtree, nested agents included. */
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  costUsd: number;
  modelCalls: number;
  toolCalls: number;
  failedSpans: number;
  /** Model calls with tokens and no cost: their model has no price (RC-482). */
  unpricedCalls: number;
  /** The same totals without the nested agents' subtrees: what this agent spent itself. */
  ownTokens: number;
  ownCostUsd: number;
}

const INVOKE_AGENT = "invoke_agent";

/** The run's agents in tree order (an agent, then its sub-agents by start time). Empty when the run has no agent span. */
export function agentSubtrees(spans: readonly AgentRollupSpan[]): AgentSubtree[] {
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const agents = spans.filter(isAgentSpan);
  if (agents.length === 0) return [];
  const agentIds = new Set(agents.map((span) => span.spanId));

  // The nearest agent at or above each span; a cycle or a missing parent ends the walk.
  const ownerOf = new Map<string, string | null>();
  const nearestAgent = (span: AgentRollupSpan, includeSelf: boolean): string | null => {
    const seen = new Set<string>();
    let found: string | null = null;
    let current: AgentRollupSpan | undefined = includeSelf ? span : parentOf(span, byId);
    while (current && !seen.has(current.spanId)) {
      if (agentIds.has(current.spanId)) {
        found = current.spanId;
        break;
      }
      const known = ownerOf.get(current.spanId);
      if (known !== undefined) {
        found = known;
        break;
      }
      seen.add(current.spanId);
      current = parentOf(current, byId);
    }
    // Every span walked has the same owner: remember it, so spans that arrive
    // before their parents do not each walk to the root.
    for (const id of seen) ownerOf.set(id, found);
    return found;
  };
  for (const span of spans) ownerOf.set(span.spanId, nearestAgent(span, true));

  const rows = new Map<string, AgentSubtree>();
  for (const span of agents) {
    rows.set(span.spanId, {
      spanId: span.spanId,
      parentAgentSpanId: nearestAgent(span, false),
      depth: 0,
      name: stringAttribute(span.attributes, "gen_ai.agent.name") ?? humanSpanName(span.name),
      model: span.model ?? stringAttribute(span.attributes, "gen_ai.request.model"),
      durationMs: finite(span.durationMs),
      inputTokens: 0,
      outputTokens: 0,
      tokens: 0,
      costUsd: 0,
      modelCalls: 0,
      toolCalls: 0,
      failedSpans: 0,
      unpricedCalls: 0,
      ownTokens: 0,
      ownCostUsd: 0,
    });
  }

  // Each span counts once, for its own agent. The agents above it get it in the sum below.
  for (const span of [...spans].sort(compareSpans)) {
    const owner = ownerOf.get(span.spanId);
    if (!owner) continue;
    const input = span.inputTokens ?? 0;
    const output = span.outputTokens ?? 0;
    const cost = toNumber(span.costUsd);
    const kind = stepKind(span);
    const row = rows.get(owner)!;
    row.ownTokens += input + output;
    row.ownCostUsd += cost;
    if (row.model === null && kind === "model" && span.model) row.model = span.model;
    row.inputTokens += input;
    row.outputTokens += output;
    row.tokens += input + output;
    row.costUsd += cost;
    if (kind === "model") row.modelCalls += 1;
    if (kind === "tool") row.toolCalls += 1;
    if (span.statusCode === 2) row.failedSpans += 1;
    if (isUnpricedCall(span)) row.unpricedCalls += 1;
  }

  const children = new Map<string | null, AgentRollupSpan[]>();
  for (const span of [...agents].sort(compareSpans)) {
    const parent = rows.get(span.spanId)!.parentAgentSpanId;
    const siblings = children.get(parent);
    if (siblings) siblings.push(span);
    else children.set(parent, [span]);
  }
  // Tree order without recursion: a chain of thousands of nested agents must not overflow the stack.
  const order: Array<{ row: AgentSubtree; depth: number }> = [];
  const pending: Array<{ span: AgentRollupSpan; depth: number }> = (children.get(null) ?? [])
    .map((span) => ({ span, depth: 0 }))
    .reverse();
  while (pending.length > 0) {
    const { span, depth } = pending.pop()!;
    order.push({ row: rows.get(span.spanId)!, depth });
    const nested = children.get(span.spanId) ?? [];
    for (let index = nested.length - 1; index >= 0; index -= 1)
      pending.push({ span: nested[index]!, depth: depth + 1 });
  }
  // In tree order a sub-agent comes after its parent, so backwards each
  // subtree is complete before it is added to the agent above it.
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const { row } = order[index]!;
    const parent = row.parentAgentSpanId ? rows.get(row.parentAgentSpanId) : undefined;
    if (!parent) continue;
    parent.inputTokens += row.inputTokens;
    parent.outputTokens += row.outputTokens;
    parent.tokens += row.tokens;
    parent.costUsd += row.costUsd;
    parent.modelCalls += row.modelCalls;
    parent.toolCalls += row.toolCalls;
    parent.failedSpans += row.failedSpans;
    parent.unpricedCalls += row.unpricedCalls;
  }
  return order.map(({ row, depth }) => ({
    ...row,
    depth,
    costUsd: money(row.costUsd),
    ownCostUsd: money(row.ownCostUsd),
  }));
}

/** Whether the run hands work to a sub-agent: only then the agents are worth a table. */
export function hasSubAgents(agents: readonly AgentSubtree[]): boolean {
  return agents.some((agent) => agent.depth > 0);
}

function isAgentSpan(span: AgentRollupSpan): boolean {
  return (
    (span.operationName ?? stringAttribute(span.attributes, "gen_ai.operation.name")) ===
    INVOKE_AGENT
  );
}

function parentOf(
  span: AgentRollupSpan,
  byId: ReadonlyMap<string, AgentRollupSpan>,
): AgentRollupSpan | undefined {
  return span.parentSpanId ? byId.get(span.parentSpanId) : undefined;
}

function compareSpans(left: AgentRollupSpan, right: AgentRollupSpan): number {
  const difference = time(left.startedAt) - time(right.startedAt);
  if (difference !== 0) return difference;
  return left.spanId < right.spanId ? -1 : left.spanId > right.spanId ? 1 : 0;
}

function time(value: Date | string): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function finite(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function toNumber(value: string | number | null): number {
  if (value === null) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Summed floats drift (`0.1 + 0.2`); a cost keeps nine decimals, more than a price has. */
function money(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}
