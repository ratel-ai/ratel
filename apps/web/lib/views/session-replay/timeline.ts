/**
 * One session as a replay timeline (RC-144): each turn, then its model calls,
 * searches and tool calls in the order they happened, numbered from 1 across
 * the session. Pure: `load.ts` reads the rows.
 *
 * Each step says how much of it can still be shown (`coverage`): `content`
 * when the model call before it carried message text, `tokens_only` when the
 * call carried only counts, and `expired` once the step's source event was
 * pruned (`trace_events` keeps 30 days). The timeline itself holds ids,
 * counts and codes only, never text.
 */

export type Coverage = "content" | "tokens_only" | "expired";
/** `retry`: the same target again after it failed. `loop`: the same target a third time in a turn, or a search after a tool call. */
export type StepMark = "retry" | "loop" | "abandoned";

export interface TimelineTurn {
  id: string;
  startedAt: Date;
  endedAt: Date;
  endedBy: string | null;
  abandoned: boolean | null;
  detour: boolean;
  reSearchCount: number;
  steps: TimelineLedgerStep[];
}

export interface TimelineLedgerStep {
  ordinal: number;
  kind: "search" | "invoke";
  traceEventId: string;
  occurredAt: Date;
  /** The step's `trace_events` row still exists. */
  eventPresent: boolean;
  targetType: string | null;
  targetId: string | null;
  outcome: string | null;
  tookMs: number | null;
  searchType: string | null;
  hitCount: number | null;
  hitIds: string[] | null;
}

export interface TimelineModelCall {
  eventId: string;
  turnId: string;
  occurredAt: Date;
  model: string | null;
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  /** The call's payload carried message or system text. The text itself never leaves the database. */
  hasContent: boolean;
}

export interface TimelineSelfCorrection {
  turnId: string;
  kind: string;
  stepOrdinal: number | null;
}

export interface TimelineInput {
  sessionId: string;
  turns: readonly TimelineTurn[];
  modelCalls: readonly TimelineModelCall[];
  selfCorrections: readonly TimelineSelfCorrection[];
}

interface StepBase {
  /** 1-based position in the session: "step N". */
  index: number;
  turnId: string;
  /** 1-based turn number in the session. */
  turnIndex: number;
  at: string;
  coverage: Coverage;
  marks: StepMark[];
}

export type TimelineStep =
  | (StepBase & {
      kind: "turn";
      endedBy: string | null;
      abandoned: boolean | null;
      detour: boolean;
      reSearchCount: number;
    })
  | (StepBase & {
      kind: "model_call";
      eventId: string;
      model: string | null;
      finishReason: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
      cachedTokens: number | null;
      costUsd: number | null;
      latencyMs: number | null;
    })
  | (StepBase & {
      kind: "search";
      ordinal: number;
      traceEventId: string;
      searchType: string | null;
      hitCount: number | null;
      hitIds: string[];
    })
  | (StepBase & {
      kind: "tool_call";
      ordinal: number;
      traceEventId: string;
      targetType: string | null;
      targetId: string | null;
      outcome: string | null;
      tookMs: number | null;
    });

export interface SessionTimeline {
  sessionId: string;
  turnCount: number;
  steps: TimelineStep[];
  coverage: Record<Coverage, number>;
}

const LOOP_REPEATS = 3;
const SELF_CORRECTION_MARKS: Readonly<Record<string, StepMark>> = {
  retry_after_error: "retry",
  searched_again: "loop",
};

export function buildSessionTimeline(input: TimelineInput): SessionTimeline {
  const turns = [...input.turns].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id),
  );
  const callsByTurn = groupBy(input.modelCalls, (call) => call.turnId);
  const correctionsByTurn = groupBy(input.selfCorrections, (row) => row.turnId);
  const steps: TimelineStep[] = [];
  turns.forEach((turn, i) => {
    const turnIndex = i + 1;
    const calls = [...(callsByTurn.get(turn.id) ?? [])].sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
    );
    steps.push({
      kind: "turn",
      index: 0,
      turnId: turn.id,
      turnIndex,
      at: turn.startedAt.toISOString(),
      coverage: turnCoverage(turn, calls),
      marks: turn.abandoned ? ["abandoned"] : [],
      endedBy: turn.endedBy,
      abandoned: turn.abandoned,
      detour: turn.detour,
      reSearchCount: turn.reSearchCount,
    });
    steps.push(...turnSteps(turn, turnIndex, calls, correctionsByTurn.get(turn.id) ?? []));
  });
  steps.forEach((step, i) => (step.index = i + 1));
  const coverage: Record<Coverage, number> = { content: 0, tokens_only: 0, expired: 0 };
  for (const step of steps) coverage[step.coverage] += 1;
  return { sessionId: input.sessionId, turnCount: turns.length, steps, coverage };
}

/** A turn's model calls and ledger steps by time; a call at the same instant as a step comes first. */
function turnSteps(
  turn: TimelineTurn,
  turnIndex: number,
  calls: readonly TimelineModelCall[],
  corrections: readonly TimelineSelfCorrection[],
): TimelineStep[] {
  const ledger = [...turn.steps].sort((a, b) => a.ordinal - b.ordinal);
  const marks = ledgerMarks(ledger, corrections);
  const out: TimelineStep[] = [];
  let lastCall: TimelineModelCall | null = null;
  let c = 0;
  const pushCall = (call: TimelineModelCall) => {
    lastCall = call;
    out.push({
      kind: "model_call",
      index: 0,
      turnId: turn.id,
      turnIndex,
      at: call.occurredAt.toISOString(),
      coverage: call.hasContent ? "content" : "tokens_only",
      marks: [],
      eventId: call.eventId,
      model: call.model,
      finishReason: call.finishReason,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cachedTokens: call.cachedTokens,
      costUsd: call.costUsd,
      latencyMs: call.latencyMs,
    });
  };
  for (const step of ledger) {
    while (c < calls.length && calls[c]!.occurredAt.getTime() <= step.occurredAt.getTime())
      pushCall(calls[c++]!);
    const before = lastCall as TimelineModelCall | null;
    const base = {
      index: 0,
      turnId: turn.id,
      turnIndex,
      at: step.occurredAt.toISOString(),
      coverage: (!step.eventPresent
        ? "expired"
        : before?.hasContent
          ? "content"
          : "tokens_only") as Coverage,
      marks: marks.get(step.ordinal) ?? [],
    };
    if (step.kind === "search") {
      out.push({
        ...base,
        kind: "search",
        ordinal: step.ordinal,
        traceEventId: step.traceEventId,
        searchType: step.searchType,
        hitCount: step.hitCount,
        hitIds: step.hitIds ?? [],
      });
    } else {
      out.push({
        ...base,
        kind: "tool_call",
        ordinal: step.ordinal,
        traceEventId: step.traceEventId,
        targetType: step.targetType,
        targetId: step.targetId,
        outcome: step.outcome,
        tookMs: step.tookMs,
      });
    }
  }
  while (c < calls.length) pushCall(calls[c++]!);
  return out;
}

/** Retry and loop marks per step ordinal, from the step order and the detectors' self-corrections. */
function ledgerMarks(
  ledger: readonly TimelineLedgerStep[],
  corrections: readonly TimelineSelfCorrection[],
): Map<number, StepMark[]> {
  const out = new Map<number, StepMark[]>();
  const add = (ordinal: number, mark: StepMark) => {
    const list = out.get(ordinal) ?? [];
    if (!list.includes(mark)) list.push(mark);
    out.set(ordinal, list);
  };
  const lastOutcome = new Map<string, string | null>();
  const seen = new Map<string, number>();
  let invoked = false;
  for (const step of ledger) {
    if (step.kind === "search") {
      if (invoked) add(step.ordinal, "loop");
      continue;
    }
    invoked = true;
    if (!step.targetId) continue;
    const key = `${step.targetType ?? ""}:${step.targetId}`;
    if (lastOutcome.get(key) === "error") add(step.ordinal, "retry");
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count >= LOOP_REPEATS) add(step.ordinal, "loop");
    lastOutcome.set(key, step.outcome);
  }
  for (const row of corrections) {
    const mark = SELF_CORRECTION_MARKS[row.kind];
    if (mark && row.stepOrdinal !== null) add(row.stepOrdinal, mark);
  }
  return out;
}

function turnCoverage(turn: TimelineTurn, calls: readonly TimelineModelCall[]): Coverage {
  if (calls.some((call) => call.hasContent)) return "content";
  if (calls.length > 0 || turn.steps.some((step) => step.eventPresent)) return "tokens_only";
  return "expired";
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) out.set(key(row), [...(out.get(key(row)) ?? []), row]);
  return out;
}
