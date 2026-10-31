import {
  type CountedTool,
  EXAMPLES_PER_STEP,
  FLOW_STARTS,
  FLOW_STEPS,
  FLOW_TOPICS_PER_STEP,
  type FlowColumn,
  type FlowNode,
  type FlowStats,
  NEXT_ENDED,
  NEXT_OTHER,
  NEXT_RETRY,
  type NextCount,
  TOOLS_PER_STEP,
  type TopicFlows,
} from "@/lib/readings/topics/types";
import { PREREQ_WINDOW_MS } from "@/lib/readings/trace-signals/signals/prerequisites";

/**
 * Flows: topics across a conversation's turns. A conversation is one user's
 * turns in one session (`session_id` and end user, as the prerequisites read
 * splits them), in start order, cut where the user was quiet for longer than
 * {@link PREREQ_WINDOW_MS}. Each turn is its topic, "Asked again" when it
 * repeats the turn before, or Other (a topic outside a step's busiest, or no
 * topic). Steps 1 to 4, then Ended. Precomputed for every conversation and
 * for those starting in each of the busiest topics. Pure; ids and counts only.
 */

/** A turn as a flow reads it. */
export interface FlowTurn {
  id: string;
  sessionId: string;
  endUserKey: string | null;
  startedAt: Date;
  endedAt: Date;
  /** A topic id, `retry` or `other`. */
  key: string;
  answered: boolean;
  calls: readonly { tool: string; outcome: string | null }[];
}

const byStart = <T extends Pick<FlowTurn, "id" | "startedAt">>(a: T, b: T) =>
  a.startedAt.getTime() - b.startedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Conversations, each in start order, oldest conversation first. */
export function conversations<
  T extends Pick<FlowTurn, "id" | "sessionId" | "endUserKey" | "startedAt" | "endedAt">,
>(turns: readonly T[], gapMs: number = PREREQ_WINDOW_MS): T[][] {
  const bySession = new Map<string, T[]>();
  for (const turn of turns) {
    const key = `${turn.sessionId}\u0001${turn.endUserKey ?? ""}`;
    const list = bySession.get(key);
    if (list) list.push(turn);
    else bySession.set(key, [turn]);
  }
  const out: T[][] = [];
  for (const list of bySession.values()) {
    list.sort(byStart);
    let current: T[] = [];
    for (const turn of list) {
      const previous = current.at(-1);
      if (previous && turn.startedAt.getTime() - previous.endedAt.getTime() > gapMs) {
        out.push(current);
        current = [];
      }
      current.push(turn);
    }
    if (current.length > 0) out.push(current);
  }
  return out.sort((a, b) => byStart(a[0]!, b[0]!));
}

/** Back-to-back asks a reading needs before it can tell conversations are shared. */
export const SHARED_MIN_PAIRS = 10;
/** Share of back-to-back asks that overlap from which conversations read as shared. */
export const SHARED_OVERLAP_SHARE = 0.2;

/**
 * Whether conversations look shared by several people at once. One person's
 * asks come one after another, so when many asks start before the one before
 * them ended, the session (or conversation id) holds more than one person and
 * what someone asks next can't be read. Guessed SDK runs never overlap (a
 * session's runs are cut one after another, and `trustOf` reads their mixing
 * from their caps); this catches declared turn ids or telemetry under one
 * shared session.
 */
export function conversationsLookShared(
  list: readonly (readonly Pick<FlowTurn, "startedAt" | "endedAt">[])[],
  minPairs: number = SHARED_MIN_PAIRS,
  share: number = SHARED_OVERLAP_SHARE,
): boolean {
  let pairs = 0;
  let overlapping = 0;
  for (const conversation of list) {
    for (let index = 1; index < conversation.length; index += 1) {
      pairs += 1;
      if (conversation[index]!.startedAt.getTime() < conversation[index - 1]!.endedAt.getTime())
        overlapping += 1;
    }
  }
  return pairs >= minPairs && overlapping / pairs >= share;
}

const isTopic = (key: string) => key !== NEXT_RETRY && key !== NEXT_OTHER;

function ranked(counts: ReadonlyMap<string, number>): string[] {
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([key]) => key);
}

interface NodeAcc {
  sessions: number;
  unanswered: number;
  ended: number;
  next: Map<string, number>;
  tools: Map<string, { calls: number; failures: number }>;
  examples: string[];
}

function bump(map: Map<string, number>, key: string, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

function topTools(
  tools: ReadonlyMap<string, { calls: number; failures: number }>,
  limit: number,
): CountedTool[] {
  return [...tools]
    .map(([id, counted]) => ({ id, ...counted }))
    .sort((a, b) => b.calls - a.calls || b.failures - a.failures || (a.id < b.id ? -1 : 1))
    .slice(0, limit);
}

function nextList(next: ReadonlyMap<string, number>): NextCount[] {
  return [...next]
    .map(([key, sessions]) => ({ key, sessions }))
    .sort((a, b) => b.sessions - a.sessions || (a.key < b.key ? -1 : 1));
}

/** One view of the flows: the given conversations across steps 1 to {@link FLOW_STEPS}. */
export function flowStats(
  list: readonly (readonly FlowTurn[])[],
  steps: number = FLOW_STEPS,
): FlowStats {
  // Each step names its busiest topics; the rest fold into Other.
  const named = Array.from({ length: steps }, (_, position) => {
    const counts = new Map<string, number>();
    for (const conversation of list) {
      const key = conversation[position]?.key;
      if (key !== undefined && isTopic(key)) bump(counts, key);
    }
    return new Set(ranked(counts).slice(0, FLOW_TOPICS_PER_STEP));
  });
  const keyAt = (turn: FlowTurn, position: number) =>
    isTopic(turn.key) && !named[position]!.has(turn.key) ? NEXT_OTHER : turn.key;

  const columns = Array.from({ length: steps }, () => new Map<string, NodeAcc>());
  for (const conversation of list) {
    const reach = Math.min(conversation.length, steps);
    for (let position = 0; position < reach; position += 1) {
      const turn = conversation[position]!;
      const key = keyAt(turn, position);
      const node: NodeAcc = columns[position]!.get(key) ?? {
        sessions: 0,
        unanswered: 0,
        ended: 0,
        next: new Map(),
        tools: new Map(),
        examples: [],
      };
      columns[position]!.set(key, node);
      node.sessions += 1;
      if (!turn.answered) node.unanswered += 1;
      const following = conversation[position + 1];
      if (!following) node.ended += 1;
      else if (position + 1 < steps) bump(node.next, keyAt(following, position + 1));
      for (const call of turn.calls) {
        const tool = node.tools.get(call.tool) ?? { calls: 0, failures: 0 };
        tool.calls += 1;
        if (call.outcome === "error") tool.failures += 1;
        node.tools.set(call.tool, tool);
      }
      // Newest conversations last: keep the latest few as examples.
      node.examples.push(turn.id);
      if (node.examples.length > EXAMPLES_PER_STEP) node.examples.shift();
    }
  }

  const out: FlowColumn[] = [];
  columns.forEach((nodes, position) => {
    if (nodes.size === 0) return;
    const built: FlowNode[] = [...nodes]
      .map(([key, node]) => ({
        key,
        sessions: node.sessions,
        unanswered: node.unanswered,
        ended: node.ended,
        next: nextList(node.next),
        tools: topTools(node.tools, TOOLS_PER_STEP),
        examples: [...node.examples].reverse(),
      }))
      // Topics busiest first, then Asked again, then Other.
      .sort(
        (a, b) =>
          order(a.key) - order(b.key) || b.sessions - a.sessions || (a.key < b.key ? -1 : 1),
      );
    out.push({
      position: position + 1,
      sessions: built.reduce((sum, node) => sum + node.sessions, 0),
      ended: built.reduce((sum, node) => sum + node.ended, 0),
      nodes: built,
    });
  });
  return {
    sessions: list.length,
    multiTurn: list.filter((conversation) => conversation.length > 1).length,
    wentOn: list.filter((conversation) => conversation.length > steps).length,
    columns: out,
  };
}

const order = (key: string) => (key === NEXT_OTHER ? 2 : key === NEXT_RETRY ? 1 : 0);

/** Every view: all conversations, and those starting in each of the busiest starting topics. */
export function buildFlows(list: readonly (readonly FlowTurn[])[]): TopicFlows {
  const firsts = new Map<string, number>();
  for (const conversation of list) {
    const key = conversation[0]?.key;
    if (key !== undefined && isTopic(key)) bump(firsts, key);
  }
  const starts = ranked(firsts).slice(0, FLOW_STARTS);
  return {
    all: flowStats(list),
    starts,
    byStart: Object.fromEntries(
      starts.map((start) => [
        start,
        flowStats(list.filter((conversation) => conversation[0]?.key === start)),
      ]),
    ),
  };
}

/** What followed each topic's turns anywhere in a conversation: the next turn's key, or Ended. Busiest first. */
export function nextByTopic(
  list: readonly (readonly FlowTurn[])[],
  limit: number,
): Map<string, NextCount[]> {
  const counts = new Map<string, Map<string, number>>();
  for (const conversation of list) {
    conversation.forEach((turn, index) => {
      if (!isTopic(turn.key)) return;
      const map = counts.get(turn.key) ?? new Map<string, number>();
      counts.set(turn.key, map);
      bump(map, conversation[index + 1]?.key ?? NEXT_ENDED);
    });
  }
  return new Map([...counts].map(([key, map]) => [key, nextList(map).slice(0, limit)]));
}
