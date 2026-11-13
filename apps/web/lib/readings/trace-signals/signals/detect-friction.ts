import { evidenceOf, laneOf, round4 } from "@/lib/readings/trace-signals/signals/build";
import type { Floors } from "@/lib/readings/trace-signals/signals/catalog";
import {
  type AgentStats,
  modelMixOf,
  type OtelStats,
  type OtelToolStats,
  type TokenBucket,
} from "@/lib/readings/trace-signals/signals/otel-accumulators";
import { median, wilson, wilsonLow } from "@/lib/readings/trace-signals/signals/severity";
import type { DetectedSignal } from "@/lib/readings/trace-signals/signals/types";

/**
 * Where an agent loses time, money or whole requests without a tool looking
 * broken, read from OTel tool spans and model round trips. Found first in a
 * multi-agent customer's data (subagents, background tasks, tools that report
 * failure in their result), and kept general.
 *
 * - `blocked_action` (subject: the tool): calls refused for permission, plan
 *   or budget (a 401 or 403, `tool_not_declared`, `insufficient_credits`).
 *   The agent tried what its access does not cover, so the prompt or the tool
 *   list offers more than the agent may do. Fires at `minCalls` blocked calls
 *   over `minTurns` turns; severity is the Wilson lower bound of the share of
 *   the tool's turns that hit one.
 * - `identical_retry` (subject: the tool): after a call fails, the agent sends
 *   the same call again, same arguments, in the same turn. Fires at
 *   `minTurns` such turns and a `minShare` of the turns where the tool failed;
 *   severity is the Wilson lower bound of that share. Measured only when
 *   arguments are captured.
 * - `wait_heavy` (subject: the tool): one tool holds a large share of all
 *   turn time, and its typical call is long: a wait, poll or long job the turn
 *   sits through. Fires at `minCalls` timed calls, a share of at least
 *   `minShare` of OTel turn time and a median call of at least `minMedianMs`;
 *   severity is that share.
 * - `token_heavy` (subject: the project): the heaviest `topShare` of turns
 *   use at least `minTokenShare` of all input tokens, and they average at
 *   least `minRatio` times the median turn. Fires at `minTurns` turns with
 *   model calls; severity is the heavy turns' share of tokens.
 * - `system_turn_failing` (subject: the project): turns a system started (a
 *   background task reporting back, a subagent's brief) fail far more often
 *   than turns a person started. Fires at `minTurns` system-started turns, a
 *   Wilson lower bound of their failure share of at least `minLow`, and
 *   `minRatio` times the person-started share; severity is that bound.
 *   Measured only when prompts are captured.
 * - `agent_failing` (subject: one agent, `agent:<name>`): a subagent whose
 *   tool calls fail far more often than the other agents' calls. Fires at
 *   `minCalls` calls, a Wilson lower bound of its failure share of at least
 *   `minLow` and `minRatio` times the others' share, with at least two named
 *   agents; severity is that bound. Names the tools behind the failures.
 */

/** Tools named on an `agent_failing` card. */
export const AGENT_TOOLS_NAMED = 3;

function sortedTools(stats: OtelStats): OtelToolStats[] {
  return [...stats.tools.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function topCode(codes: ReadonlyMap<string, number>): string | null {
  let best: [string, number] | null = null;
  for (const entry of [...codes].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  return best?.[0] ?? null;
}

export function blockedActions(stats: OtelStats, floors: Floors): DetectedSignal[] {
  const f = floors.blocked_action;
  return sortedTools(stats).flatMap((tool): DetectedSignal[] => {
    const k = tool.blockedTurns;
    const n = tool.turns;
    if (tool.blockedCalls < f.minCalls || k < f.minTurns || n === 0) return [];
    const interval = wilson(k, n);
    return [
      {
        kind: "blocked_action",
        subjectKind: "tool",
        subjectKey: tool.id,
        subjectIds: [tool.id],
        entryKind: "tool",
        lane: laneOf(tool.mix),
        severity: round4(wilsonLow(k, n)),
        impact: tool.blockedCalls,
        n,
        route: "show_turns",
        metrics: {
          k,
          n,
          calls: tool.blockedCalls,
          share: round4(k / n),
          code: topCode(tool.blockedCodes),
          low: round4(interval?.low ?? 0),
          high: round4(interval?.high ?? 1),
        },
        evidence: evidenceOf(tool.blockedEvidence.values(), tool.blockedEvidence.total),
      },
    ];
  });
}

export function identicalRetries(stats: OtelStats, floors: Floors): DetectedSignal[] {
  const f = floors.identical_retry;
  return sortedTools(stats).flatMap((tool): DetectedSignal[] => {
    const k = tool.retryTurns;
    const n = tool.failedTurns;
    if (k < f.minTurns || n === 0 || k / n < f.minShare) return [];
    const interval = wilson(k, n);
    return [
      {
        kind: "identical_retry",
        subjectKind: "tool",
        subjectKey: tool.id,
        subjectIds: [tool.id],
        entryKind: "tool",
        lane: laneOf(tool.mix),
        severity: round4(wilsonLow(k, n)),
        impact: k,
        n,
        route: "show_turns",
        metrics: {
          k,
          n,
          share: round4(k / n),
          low: round4(interval?.low ?? 0),
          high: round4(interval?.high ?? 1),
        },
        evidence: evidenceOf(tool.retryEvidence.values(), tool.retryEvidence.total),
      },
    ];
  });
}

export function waitHeavy(stats: OtelStats, floors: Floors): DetectedSignal[] {
  const f = floors.wait_heavy;
  if (stats.turnMs <= 0) return [];
  return sortedTools(stats).flatMap((tool): DetectedSignal[] => {
    if (tool.timedCalls < f.minCalls) return [];
    const share = Math.min(1, tool.timeMs / stats.turnMs);
    const medianMs = median(tool.durations.values()) ?? 0;
    if (share < f.minShare || medianMs < f.minMedianMs) return [];
    return [
      {
        kind: "wait_heavy",
        subjectKind: "tool",
        subjectKey: tool.id,
        subjectIds: [tool.id],
        entryKind: "tool",
        lane: laneOf(tool.mix),
        severity: round4(share),
        impact: tool.timedCalls,
        n: tool.timedCalls,
        route: "none",
        metrics: {
          calls: tool.timedCalls,
          turns: tool.turns,
          share: round4(share),
          medianMs: Math.round(medianMs),
          timeMs: Math.round(tool.timeMs),
          turnMs: Math.round(stats.turnMs),
        },
        evidence: evidenceOf(tool.timeEvidence.values(), tool.turns),
      },
    ];
  });
}

/** The heaviest `topShare` of turns from the token buckets: their turn count, tokens and evidence. */
function heaviest(buckets: ReadonlyMap<number, TokenBucket>, total: number, topShare: number) {
  const want = Math.max(1, Math.ceil(total * topShare));
  let turns = 0;
  let tokens = 0;
  const picked: TokenBucket[] = [];
  for (const [, bucket] of [...buckets].sort(([a], [b]) => b - a)) {
    if (turns >= want) break;
    const take = Math.min(bucket.turns, want - turns);
    // A bucket split at the cut lends its average per turn.
    tokens += take === bucket.turns ? bucket.tokens : (bucket.tokens / bucket.turns) * take;
    turns += take;
    picked.push(bucket);
  }
  return { turns, tokens, picked };
}

/** The median turn's tokens, by nearest rank, at its bucket's average. */
function medianTokens(buckets: ReadonlyMap<number, TokenBucket>, total: number): number {
  const rank = Math.max(0, Math.ceil(0.5 * total) - 1);
  let seen = 0;
  for (const [, bucket] of [...buckets].sort(([a], [b]) => a - b)) {
    seen += bucket.turns;
    if (seen > rank) return bucket.tokens / bucket.turns;
  }
  return 0;
}

export function tokenHeavy(stats: OtelStats, floors: Floors): DetectedSignal[] {
  const f = floors.token_heavy;
  const n = stats.tokenTurns;
  if (n < f.minTurns) return [];
  const all = [...stats.tokenBuckets.values()].reduce((sum, bucket) => sum + bucket.tokens, 0);
  const top = heaviest(stats.tokenBuckets, n, f.topShare);
  const typical = medianTokens(stats.tokenBuckets, n);
  const tokenShare = all > 0 ? top.tokens / all : 0;
  const ratio = typical > 0 ? top.tokens / top.turns / typical : 0;
  if (tokenShare < f.minTokenShare || ratio < f.minRatio) return [];
  const max = Math.max(...[...stats.tokenBuckets.values()].map((bucket) => bucket.max));
  return [
    {
      kind: "token_heavy",
      subjectKind: "project",
      subjectKey: "project",
      subjectIds: [],
      entryKind: "tool",
      lane: laneOf(modelMixOf(stats)),
      severity: round4(tokenShare),
      impact: top.turns,
      n,
      route: "show_turns",
      metrics: {
        k: top.turns,
        n,
        turnShare: round4(top.turns / n),
        tokenShare: round4(tokenShare),
        heavyTokens: Math.round(top.tokens / top.turns),
        typicalTokens: Math.round(typical),
        maxTokens: max,
        totalTokens: Math.round(all),
        ratio: round4(ratio),
      },
      evidence: evidenceOf(
        top.picked.flatMap((bucket) => [...bucket.evidence.values()]),
        top.turns,
      ),
    },
  ];
}

export function systemTurnFailing(stats: OtelStats, floors: Floors): DetectedSignal[] {
  const f = floors.system_turn_failing;
  const system = stats.started.system;
  const person = stats.started.person;
  const k = system.failedTurns;
  const n = system.turns;
  if (n < f.minTurns) return [];
  const low = wilsonLow(k, n);
  const personShare = person.turns > 0 ? person.failedTurns / person.turns : 0;
  if (low < f.minLow || k / n < f.minRatio * personShare) return [];
  const interval = wilson(k, n);
  return [
    {
      kind: "system_turn_failing",
      subjectKind: "project",
      subjectKey: "project",
      subjectIds: [],
      entryKind: "tool",
      lane: laneOf(stats.mix),
      severity: round4(low),
      impact: k,
      n,
      route: "show_turns",
      metrics: {
        k,
        n,
        share: round4(k / n),
        personTurns: person.turns,
        personFailed: person.failedTurns,
        personShare: round4(personShare),
        medianMs: Math.round(median(system.durations.values()) ?? 0),
        personMedianMs: Math.round(median(person.durations.values()) ?? 0),
        low: round4(interval?.low ?? 0),
        high: round4(interval?.high ?? 1),
      },
      evidence: evidenceOf(system.failedEvidence.values(), k),
    },
  ];
}

function topFailingTools(agent: AgentStats): string[] {
  return [...agent.toolFailures]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .slice(0, AGENT_TOOLS_NAMED)
    .map(([id]) => id);
}

export function agentFailing(stats: OtelStats, floors: Floors): DetectedSignal[] {
  const f = floors.agent_failing;
  const agents = [...stats.agents.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  if (agents.length < 2) return [];
  const allCalls = agents.reduce((sum, agent) => sum + agent.calls, 0);
  const allFailed = agents.reduce((sum, agent) => sum + agent.failedCalls, 0);
  return agents.flatMap((agent): DetectedSignal[] => {
    const k = agent.failedCalls;
    const n = agent.calls;
    if (n < f.minCalls) return [];
    const low = wilsonLow(k, n);
    const otherCalls = allCalls - n;
    const othersShare = otherCalls > 0 ? (allFailed - k) / otherCalls : 0;
    if (low < f.minLow || k / n < f.minRatio * othersShare) return [];
    const tools = topFailingTools(agent);
    const interval = wilson(k, n);
    return [
      {
        kind: "agent_failing",
        subjectKind: "project",
        subjectKey: `agent:${agent.id}`,
        subjectIds: tools,
        entryKind: "tool",
        lane: laneOf(stats.mix),
        severity: round4(low),
        impact: k,
        n,
        route: "show_turns",
        metrics: {
          k,
          n,
          agent: agent.id,
          turns: agent.turns,
          share: round4(k / n),
          othersShare: round4(othersShare),
          tools,
          toolFailures: tools.map((id) => agent.toolFailures.get(id) ?? 0),
          low: round4(interval?.low ?? 0),
          high: round4(interval?.high ?? 1),
        },
        evidence: evidenceOf(agent.failedEvidence.values(), agent.failedEvidence.total),
      },
    ];
  });
}
