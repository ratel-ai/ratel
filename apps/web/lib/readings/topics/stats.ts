import { isAnswered, type TopicTurn } from "@/lib/readings/topics/asks";
import {
  buildFlows,
  conversations,
  conversationsLookShared,
  type FlowTurn,
  nextByTopic,
} from "@/lib/readings/topics/flows";
import {
  type AskSourceKind,
  type CountedTool,
  dayIndex,
  EXAMPLES_PER_TOPIC,
  flowTaskKey,
  flowToolKey,
  isModelOnlyTurn,
  MODEL_ONLY_PREFIX,
  NEXT_OTHER,
  NEXT_PER_TOPIC,
  NEXT_RETRY,
  type Sentiment,
  TASKS_PER_TOPIC,
  TOOLS_PER_TOPIC,
  TOPIC_INSIGHTS_VERSION,
  TOPIC_WINDOW_DAYS,
  type TopicInsights,
  type TopicStats,
  type TopicVerdict,
} from "@/lib/readings/topics/types";

/**
 * The numbers a reading stores: per topic (daily turns, conversations,
 * answered, sentiment, tasks, tools, self-corrections, example turn ids, what
 * came next), the Flows, and the totals the page's header reads: how
 * sentiment was read, and which lanes the turns came by. Pure.
 */

/** One turn's place, as the reading decided it. */
export interface PlacedTurn {
  turn: TopicTurn;
  verdict: TopicVerdict;
  topicId: string | null;
  source: AskSourceKind | null;
  askHash: string | null;
  sentiment: Sentiment | null;
  /** Whether the decision engine read that sentiment; otherwise the keyword list did. */
  sentimentByModel?: boolean;
  /** For a retry: the turn it asked again. */
  retryOf: string | null;
}

/**
 * A telemetry turn that carried no conversation id: OpenTelemetry falls back
 * to the trace as the session (`lib/otlp/derive-tools.ts`), and a trace of
 * model calls alone to its own id, so the turn is a conversation of its own.
 */
export function lacksConversationId(
  turn: Pick<TopicTurn, "id" | "turnSource" | "sessionId" | "traceId">,
): boolean {
  if (turn.turnSource !== "otlp") return false;
  if (turn.traceId && turn.sessionId === turn.traceId) return true;
  return isModelOnlyTurn(turn.id) && turn.sessionId.startsWith(MODEL_ONLY_PREFIX);
}

/** Conversations holding at least one turn of each topic. */
function conversationsByTopic(list: readonly (readonly FlowTurn[])[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const conversation of list) {
    for (const key of new Set(conversation.map((turn) => turn.key)))
      counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export interface InsightsInput {
  placed: readonly PlacedTurn[];
  /** Topic ids in the order they are listed when tied, oldest first. */
  topicIds: readonly string[];
  window: { start: Date; end: Date; readFrom: Date; capped: boolean };
  /** Self-correction kinds per turn id; null when none were recorded for the window at all. */
  selfCorrections: ReadonlyMap<string, readonly string[]> | null;
  /** Whether sessions hold one user's turns in order (`trustOf`): flows are read only then. */
  sessionsTrusted: boolean;
  naming: TopicInsights["naming"];
  placement: TopicInsights["placement"];
  namingHash: string | null;
}

function countTools(
  turns: readonly TopicTurn[],
): Map<string, { calls: number; failures: number; tasks: Map<string, number> }> {
  const tools = new Map<string, { calls: number; failures: number; tasks: Map<string, number> }>();
  for (const turn of turns) {
    for (const call of turn.calls) {
      const tool = tools.get(call.tool) ?? {
        calls: 0,
        failures: 0,
        tasks: new Map<string, number>(),
      };
      tool.calls += 1;
      if (call.outcome === "error") tool.failures += 1;
      if (turn.workflowId)
        tool.tasks.set(turn.workflowId, (tool.tasks.get(turn.workflowId) ?? 0) + 1);
      tools.set(call.tool, tool);
    }
  }
  return tools;
}

function topTools(
  tools: ReadonlyMap<string, { calls: number; failures: number }>,
  limit: number,
): CountedTool[] {
  return [...tools]
    .map(([id, tool]) => ({ id, calls: tool.calls, failures: tool.failures }))
    .sort((a, b) => b.calls - a.calls || b.failures - a.failures || (a.id < b.id ? -1 : 1))
    .slice(0, limit);
}

function mainTask(tasks: ReadonlyMap<string, number>): string | null {
  const best = [...tasks].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  return best?.[0] ?? null;
}

/** Up to `limit` turn ids, newest first, one per distinct ask, the users' own words first. */
function examples(rows: readonly PlacedTurn[], limit: number): string[] {
  const newestFirst = [...rows].sort(
    (a, b) =>
      Number(b.source !== null && b.source !== "search") -
        Number(a.source !== null && a.source !== "search") ||
      b.turn.startedAt.getTime() - a.turn.startedAt.getTime() ||
      (a.turn.id < b.turn.id ? -1 : 1),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of newestFirst) {
    const key = row.askHash ?? row.turn.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row.turn.id);
    if (out.length >= limit) break;
  }
  return out;
}

function flowKey(row: PlacedTurn): string {
  if (row.verdict === "topic" && row.topicId) return row.topicId;
  if (row.verdict === "retry") return NEXT_RETRY;
  if (row.verdict === "no_ask" && row.turn.workflowId) return flowTaskKey(row.turn.workflowId);
  if (row.verdict === "no_ask" && row.turn.calls[0]) return flowToolKey(row.turn.calls[0].tool);
  return NEXT_OTHER;
}

export function buildTopicInsights(input: InsightsInput): TopicInsights {
  const { placed, window } = input;
  const days = TOPIC_WINDOW_DAYS;
  const byTopic = new Map<string, PlacedTurn[]>();
  for (const row of placed) {
    if (row.verdict !== "topic" || !row.topicId) continue;
    const list = byTopic.get(row.topicId);
    if (list) list.push(row);
    else byTopic.set(row.topicId, [row]);
  }
  const placedById = new Map(placed.map((row) => [row.turn.id, row]));
  const askedAgain = new Map<string, number>();
  for (const row of placed) {
    if (row.verdict !== "retry" || !row.retryOf) continue;
    const first = placedById.get(row.retryOf);
    // A chain of retries counts against the topic the first ask was in.
    let origin = first;
    for (
      let hops = 0;
      origin && origin.verdict === "retry" && origin.retryOf && hops < 8;
      hops += 1
    )
      origin = placedById.get(origin.retryOf);
    if (origin?.topicId) askedAgain.set(origin.topicId, (askedAgain.get(origin.topicId) ?? 0) + 1);
  }

  const flowTurns: FlowTurn[] = placed.map((row) => ({
    id: row.turn.id,
    sessionId: row.turn.sessionId,
    endUserKey: row.turn.endUserKey,
    startedAt: row.turn.startedAt,
    endedAt: row.turn.endedAt,
    key: flowKey(row),
    answered: isAnswered(row.turn),
    calls: row.turn.calls,
  }));
  // Conversations are read only where sessions hold one person's asks in order: the run basis trusts them, and they don't overlap.
  const grouped = input.sessionsTrusted ? conversations(flowTurns) : [];
  const trusted = input.sessionsTrusted && !conversationsLookShared(grouped);
  const conversationList = trusted ? grouped : [];
  const next = nextByTopic(conversationList, NEXT_PER_TOPIC);
  const inConversations = conversationsByTopic(conversationList);

  const topics: TopicStats[] = [];
  const order = new Map(input.topicIds.map((id, index) => [id, index]));
  for (const topicId of input.topicIds) {
    const rows = byTopic.get(topicId) ?? [];
    if (rows.length === 0) continue;
    const daily = Array.from({ length: days }, () => 0);
    let answered = 0;
    let measured = 0;
    const sentiment = { positive: 0, neutral: 0, negative: 0 };
    const tasks = new Map<string, number>();
    let untasked = 0;
    const asks = new Set<string>();
    for (const row of rows) {
      const index = dayIndex(row.turn.startedAt, window.end, days);
      if (index >= 0) daily[index]! += 1;
      if (isAnswered(row.turn)) answered += 1;
      if (row.sentiment) {
        measured += 1;
        sentiment[row.sentiment] += 1;
      }
      if (row.turn.workflowId)
        tasks.set(row.turn.workflowId, (tasks.get(row.turn.workflowId) ?? 0) + 1);
      else untasked += 1;
      if (row.askHash) asks.add(row.askHash);
    }
    let selfCorrections: TopicStats["selfCorrections"] = null;
    if (input.selfCorrections) {
      const byKind: Record<string, number> = {};
      let events = 0;
      let turnsWith = 0;
      for (const row of rows) {
        const kinds = input.selfCorrections.get(row.turn.id) ?? [];
        if (kinds.length > 0) turnsWith += 1;
        for (const kind of kinds) {
          events += 1;
          byKind[kind] = (byKind[kind] ?? 0) + 1;
        }
      }
      selfCorrections = { events, turns: turnsWith, byKind };
    }
    topics.push({
      id: topicId,
      turns: rows.length,
      asks: asks.size,
      daily,
      answered,
      sentiment: measured > 0 ? sentiment : null,
      tasks: [...tasks]
        .map(([id, turns]) => ({ id, turns }))
        .sort((a, b) => b.turns - a.turns || (a.id < b.id ? -1 : 1))
        .slice(0, TASKS_PER_TOPIC),
      untasked,
      tools: topTools(countTools(rows.map((row) => row.turn)), TOOLS_PER_TOPIC),
      selfCorrections,
      examples: examples(rows, EXAMPLES_PER_TOPIC),
      askedAgain: askedAgain.get(topicId) ?? 0,
      next: next.get(topicId) ?? [],
      ...(trusted ? { conversations: inConversations.get(topicId) ?? 0 } : {}),
    });
  }
  topics.sort((a, b) => b.turns - a.turns || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  const topicTurns = placed
    .filter((row) => row.verdict === "topic" && row.topicId)
    .map((row) => row.turn);
  const tools = [...countTools(topicTurns)]
    .map(([id, tool]) => ({
      id,
      calls: tool.calls,
      failures: tool.failures,
      task: mainTask(tool.tasks),
    }))
    .sort((a, b) => b.calls - a.calls || (a.id < b.id ? -1 : 1));

  const verdicts: Record<TopicVerdict, number> = { topic: 0, retry: 0, none: 0, no_ask: 0 };
  const sources = { user: 0, prompt: 0, search: 0, none: 0 };
  let sentimentMeasured = 0;
  const sentimentRead = { model: 0, words: 0 };
  const lanes = { telemetry: 0, sdk: 0, telemetryWithoutConversation: 0 };
  const unplaced = { turns: 0, answered: 0 };
  for (const row of placed) {
    verdicts[row.verdict] += 1;
    if (row.source) sources[row.source] += 1;
    else sources.none += 1;
    if (row.sentiment) {
      sentimentMeasured += 1;
      if (row.sentimentByModel) sentimentRead.model += 1;
      else sentimentRead.words += 1;
    }
    if (row.turn.turnSource === "otlp") {
      lanes.telemetry += 1;
      if (lacksConversationId(row.turn)) lanes.telemetryWithoutConversation += 1;
    } else {
      lanes.sdk += 1;
    }
    if (row.verdict === "none") {
      unplaced.turns += 1;
      if (isAnswered(row.turn)) unplaced.answered += 1;
    }
  }

  return {
    version: TOPIC_INSIGHTS_VERSION,
    windowDays: days,
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
    readFrom: window.readFrom.toISOString(),
    capped: window.capped,
    turns: placed.length,
    modelOnlyTurns: placed.filter((row) => isModelOnlyTurn(row.turn.id)).length,
    refusedTurns: placed.filter((row) => row.turn.refused === true).length,
    sources,
    verdicts,
    sentimentMeasured,
    sentimentRead,
    lanes,
    naming: input.naming,
    placement: input.placement,
    namingHash: input.namingHash,
    topics,
    unplaced,
    tools,
    flows: trusted ? buildFlows(conversationList) : null,
    flowsBlocked: trusted ? null : "sessions_mixed",
  };
}
