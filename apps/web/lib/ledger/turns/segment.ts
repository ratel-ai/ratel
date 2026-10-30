import { DEFAULT_TURN_CONFIG, isImportedSourceId, type TurnConfig } from "@/lib/ledger/constants";
import { matchPendingStart, type PendingStart } from "@/lib/ledger/turns/attribute";
import type {
  InvocationPair,
  NormalizedEvent,
  SegmentedTurn,
  TurnEndedBy,
  TurnEventType,
  TurnSource,
} from "@/lib/ledger/types";

/**
 * The turn boundary rule, pure. Events -> turns, per (lane, session).
 *
 * 1. Order: `received_at`, then event time, then id. The same order the
 *    intent-graph fold reads in, and the one that makes the builder idempotent:
 *    every new page sorts after every stored step, so re-deriving an open turn
 *    from `stored steps + new events` walks the timeline a full rebuild walks.
 *    An event whose time is earlier than the one before it is a backwards
 *    clock: its turn is `clock_suspect` and the gap clamps to zero.
 * 2. A declared `turn_id` wins (`declared:<turn_id>`). An undeclared event after
 *    a declared turn joins it within the gap, else starts an inferred turn
 *    (mixed SDK versions in one session).
 * 3. Inferred turns (`inferred:<first event id>`) start on a session's first
 *    event, after a gap over `gapMs`, or when the current one hits a cap
 *    (`stepCap` steps or `durationCapMs`). The event's kind never splits a turn:
 *    a search after an invocation is the re-search the signals measure.
 * 4. OTLP rows (`lane = otlp`) group by trace: `otlp:<trace id | session id>`.
 *    A tool call that is its trace's root span (`rootTool`, an MCP server
 *    without propagated context: one trace per call) and carries a session
 *    groups like an inferred turn instead: consecutive such calls of the
 *    session form one run (`otlp-run:<first event id>`) until a gap over
 *    `gapMs` or a cap. Without a session each call stays its own turn.
 * 5. Every turn but the one holding the session's latest event is closed
 *    (`next_turn`, `gap`, `cap`); that one closes as `idle` once nothing was
 *    received for `idleCloseMs`, or at once when every event of it came from
 *    an Agent health import (history read once: nothing more arrives, so the
 *    reading the import asks for counts it). A declared turn that gets events
 *    again after another started becomes the latest one again.
 * 6. Gateway rows within `gatewayDedupeMs` of the native row they summarize are
 *    dropped (see {@link dedupeGateway}); otherwise they stand in.
 * 7. An end or error pairs with its start as it arrives ({@link matchPendingStart})
 *    and joins the start's turn, so a long call never splits into two turns.
 */

/** Turn-key prefix of a run of root-tool OTLP calls (rule 4). */
export const OTLP_RUN_PREFIX = "otlp-run:";

/** A root-tool OTLP call with a real session: it joins a session run, not its own trace's turn. */
function isRunEvent(event: NormalizedEvent): boolean {
  return event.rootTool === true && event.sessionId !== event.traceId;
}

export function segmentEvents(
  events: readonly NormalizedEvent[],
  now: Date,
  config: TurnConfig = DEFAULT_TURN_CONFIG,
): SegmentedTurn[] {
  const out: SegmentedTurn[] = [];
  for (const session of groupSessions(events).values()) {
    const ordered = orderTimeline(session);
    const kept =
      ordered[0]?.lane === "runtime"
        ? dedupeGateway(ordered, config.gatewayDedupeMs).kept
        : ordered;
    out.push(...segmentSession(kept, now, config));
  }
  return out;
}

/** Group by (lane, session), preserving first-appearance order. */
export function groupSessions(events: readonly NormalizedEvent[]): Map<string, NormalizedEvent[]> {
  const groups = new Map<string, NormalizedEvent[]>();
  for (const event of events) {
    const key = `${event.lane}\u0000${event.sessionId}`;
    const group = groups.get(key);
    if (group) group.push(event);
    else groups.set(key, [event]);
  }
  return groups;
}

/**
 * Where an event sits in a call's life. SDKs batch a call's start and end
 * together, often with the same millisecond timestamp, so with both times tied
 * the id alone would put an end before its start about half the time and
 * neither would pair. Seen on a design partner's traces: 45% of calls.
 */
const LIFECYCLE_RANK: Record<TurnEventType, number> = {
  search: 0,
  skill_search: 0,
  gateway_search: 0,
  invoke_start: 1,
  gateway_invoke: 1,
  skill_invoke: 1,
  invoke_end: 2,
  invoke_error: 2,
  gateway_error: 2,
};

export function compareTimeline(a: NormalizedEvent, b: NormalizedEvent): number {
  return (
    a.receivedAt - b.receivedAt ||
    a.occurredAt - b.occurredAt ||
    LIFECYCLE_RANK[a.type] - LIFECYCLE_RANK[b.type] ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function orderTimeline(events: readonly NormalizedEvent[]): NormalizedEvent[] {
  return [...events].sort(compareTimeline);
}

export interface GatewayDedupe {
  kept: NormalizedEvent[];
  gatewaySearches: number;
  gatewaySearchesDropped: number;
  gatewayInvocations: number;
  gatewayInvocationsDropped: number;
}

/**
 * Drop gateway rows that restate a native one (rule 6): a `gateway_search`
 * within the window of a native `search`/`skill_search`, and a
 * `gateway_invoke`/`gateway_error` within the window of an inner invocation
 * event of the same tool. A gateway row with no native twin stands in for it
 * (count only, no hits), so a fact is never counted twice and never lost.
 * Input is one session's events.
 */
export function dedupeGateway(events: readonly NormalizedEvent[], windowMs: number): GatewayDedupe {
  const searchTimes = sortedTimes(
    events.filter((e) => e.type === "search" || e.type === "skill_search"),
  );
  const toolTimes = new Map<string, number[]>();
  for (const e of events) {
    if (e.type !== "invoke_start" && e.type !== "invoke_end" && e.type !== "invoke_error") continue;
    if (!e.targetId) continue;
    const times = toolTimes.get(e.targetId) ?? [];
    times.push(e.occurredAt);
    toolTimes.set(e.targetId, times);
  }
  for (const times of toolTimes.values()) times.sort((a, b) => a - b);

  const kept: NormalizedEvent[] = [];
  let gatewaySearches = 0;
  let gatewaySearchesDropped = 0;
  let gatewayInvocations = 0;
  let gatewayInvocationsDropped = 0;
  for (const e of events) {
    if (e.type === "gateway_search") {
      gatewaySearches += 1;
      if (hasNear(searchTimes, e.occurredAt, windowMs)) {
        gatewaySearchesDropped += 1;
        continue;
      }
    } else if (e.type === "gateway_invoke" || e.type === "gateway_error") {
      gatewayInvocations += 1;
      const times = e.targetId ? toolTimes.get(e.targetId) : undefined;
      if (times && hasNear(times, e.occurredAt, windowMs)) {
        gatewayInvocationsDropped += 1;
        continue;
      }
    }
    kept.push(e);
  }
  return {
    kept,
    gatewaySearches,
    gatewaySearchesDropped,
    gatewayInvocations,
    gatewayInvocationsDropped,
  };
}

function sortedTimes(events: readonly NormalizedEvent[]): number[] {
  return events.map((e) => e.occurredAt).sort((a, b) => a - b);
}

/** True when a sorted list holds a value within `window` of `t`. */
function hasNear(sorted: readonly number[], t: number, window: number): boolean {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t - window) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length && sorted[lo] <= t + window;
}

interface TurnInProgress {
  key: string;
  source: TurnSource;
  events: NormalizedEvent[];
  pairs: Map<string, InvocationPair>;
  steps: number;
  startedAt: number;
  endedBy: TurnEndedBy | null;
  clockSuspect: boolean;
}

/** One session's ordered, deduped events -> its turns. */
function segmentSession(
  events: readonly NormalizedEvent[],
  now: Date,
  config: TurnConfig,
): SegmentedTurn[] {
  const turns: TurnInProgress[] = [];
  const byKey = new Map<string, number>();
  const pending: PendingStart[] = [];
  let current = -1;
  let previousAt: number | null = null;

  const open = (key: string, source: TurnSource, event: NormalizedEvent, reason: TurnEndedBy) => {
    if (current >= 0 && turns[current].endedBy === null) turns[current].endedBy = reason;
    turns.push({
      key,
      source,
      events: [],
      pairs: new Map(),
      steps: 0,
      startedAt: event.occurredAt,
      endedBy: null,
      clockSuspect: false,
    });
    current = turns.length - 1;
    byKey.set(key, current);
    return current;
  };

  // A declared (or OTLP) turn that gets events again becomes the current one:
  // the turn it interrupts is closed by it, and its own old close reason no
  // longer holds.
  const resume = (index: number) => {
    if (current >= 0 && current !== index && turns[current].endedBy === null) {
      turns[current].endedBy = "next_turn";
    }
    turns[index].endedBy = null;
    current = index;
    return index;
  };

  // Runs of root-tool OTLP calls (rule 4): the open run and its last event time.
  let run = -1;
  let runPreviousAt: number | null = null;
  const chooseRun = (event: NormalizedEvent): number => {
    const gap = runPreviousAt === null ? null : Math.max(0, event.occurredAt - runPreviousAt);
    runPreviousAt = event.occurredAt;
    const key = `${OTLP_RUN_PREFIX}${event.id}`;
    if (run < 0) {
      run = open(key, "otlp", event, "next_turn");
      return run;
    }
    if (gap !== null && gap > config.gapMs) {
      run = open(key, "otlp", event, "gap");
      return run;
    }
    const turn = turns[run];
    if (turn.steps >= config.stepCap || event.occurredAt - turn.startedAt > config.durationCapMs) {
      run = open(key, "otlp", event, "cap");
      return run;
    }
    return resume(run);
  };

  const choose = (event: NormalizedEvent, gap: number | null): number => {
    if (event.lane === "otlp" && isRunEvent(event)) return chooseRun(event);
    if (event.lane === "otlp") {
      const key = `otlp:${event.traceId ?? event.sessionId}`;
      const existing = byKey.get(key);
      if (existing !== undefined) return resume(existing);
      return open(key, "otlp", event, "next_turn");
    }
    if (event.declaredTurnId) {
      const key = `declared:${event.declaredTurnId}`;
      const existing = byKey.get(key);
      if (existing !== undefined) return resume(existing);
      return open(key, "declared", event, "next_turn");
    }
    const inferredKey = `inferred:${event.id}`;
    if (current < 0) return open(inferredKey, "inferred", event, "next_turn");
    if (gap !== null && gap > config.gapMs) return open(inferredKey, "inferred", event, "gap");
    const turn = turns[current];
    if (turn.source !== "inferred") return current;
    if (turn.steps >= config.stepCap || event.occurredAt - turn.startedAt > config.durationCapMs) {
      return open(inferredKey, "inferred", event, "cap");
    }
    return current;
  };

  for (const event of events) {
    const rawGap = previousAt === null ? null : event.occurredAt - previousAt;
    previousAt = event.occurredAt;
    const backwards = rawGap !== null && rawGap < 0;
    const gap = rawGap === null ? null : Math.max(0, rawGap);

    if (event.role === "end") {
      const match = matchPendingStart(event, pending, config.pairingWindowMs);
      if (match) {
        const start = pending[match.index];
        pending.splice(match.index, 1);
        const turn = turns[start.turn];
        turn.events.push(event);
        turn.pairs.set(start.event.id, { endId: event.id, method: match.method });
        if (backwards) turn.clockSuspect = true;
        continue;
      }
    }

    const index = choose(event, gap);
    const turn = turns[index];
    turn.events.push(event);
    turn.steps += 1;
    if (backwards) turn.clockSuspect = true;
    if (event.role === "start") pending.push({ event, turn: index });
  }

  return finalize(
    turns,
    current,
    events[0]?.sessionId ?? "",
    events[0]?.lane ?? "runtime",
    now,
    config,
  );
}

/** Close every turn but `last` (the one the session's latest event went to);
 * that one stays open until the session has been idle long enough, unless an
 * import brought all of it. */
function finalize(
  turns: readonly TurnInProgress[],
  last: number,
  sessionId: string,
  lane: NormalizedEvent["lane"],
  now: Date,
  config: TurnConfig,
): SegmentedTurn[] {
  const idleBefore = now.getTime() - config.idleCloseMs;
  return turns.map((turn, i) => {
    const lastReceived = turn.events.reduce((max, e) => Math.max(max, e.receivedAt), -Infinity);
    const imported =
      turn.events.length > 0 && turn.events.every((e) => isImportedSourceId(e.sourceId));
    const idle = i === last && (lastReceived < idleBefore || imported);
    const closed = i !== last || idle;
    return {
      lane,
      sessionId,
      turnKey: turn.key,
      turnSource: turn.source,
      events: turn.events,
      pairs: turn.pairs,
      status: closed ? "closed" : "open",
      endedBy: i !== last ? (turn.endedBy ?? "next_turn") : idle ? "idle" : null,
      clockSuspect: turn.clockSuspect,
    };
  });
}

/**
 * Raw gaps (ms, negative for a backwards clock) between consecutive events of
 * every runtime session, in the order the segmenter compares them. The Phase 0
 * replay histograms these to validate `gapMs`.
 */
export function consecutiveGaps(
  events: readonly NormalizedEvent[],
  config: TurnConfig = DEFAULT_TURN_CONFIG,
): number[] {
  const gaps: number[] = [];
  for (const session of groupSessions(events).values()) {
    if (session[0]?.lane !== "runtime") continue;
    const kept = dedupeGateway(orderTimeline(session), config.gatewayDedupeMs).kept;
    for (let i = 1; i < kept.length; i++) gaps.push(kept[i].occurredAt - kept[i - 1].occurredAt);
  }
  return gaps;
}
