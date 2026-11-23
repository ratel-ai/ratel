import {
  ERROR_KINDS,
  SELF_CORRECTION_KINDS,
  type SelfCorrection,
  type SelfCorrectionKind,
  type TurnSelfCorrections,
} from "@/lib/readings/trace-signals/self-corrections/detect";
import { wilson } from "@/lib/readings/trace-signals/signals/severity";
import type { Interval } from "@/lib/readings/trace-signals/view";

/**
 * Self-corrections over many turns: how often they happen (per 100 turns, and
 * the share of turns with one), which kinds, after which tool, in which
 * workflow, and what followed the errors. Pure: it reads the per-turn output
 * of `readTurns` (`detect.ts`), so the replay and a signal run count the same
 * way.
 *
 * Error shares count failed calls, each once: switching away from a failure
 * and later retrying it are two events about one error. A failure is
 * recovered when a later call in its turn succeeded, and asked again about
 * when the user's next turn asked the same thing; failures in turns where
 * that cannot be told are left out of that share. Every share carries its 95%
 * Wilson interval, as the signal detectors' do.
 */

/** One read turn, as the summary counts it. */
export interface SelfCorrectionReading extends TurnSelfCorrections {
  /** The workflow the run was placed in, when the caller knows it. */
  workflowId?: string | null;
}

export interface Share {
  k: number;
  n: number;
  /** k / n; null when n is 0. */
  share: number | null;
  /** 95% Wilson interval of the share; null when n is 0. */
  interval: Interval | null;
}

export type KindCounts = Record<SelfCorrectionKind, number>;

export interface ToolSelfCorrections {
  /** The call before the events, as a node id (a tool's catalog id, a skill as `skill:<id>`). */
  tool: string;
  events: number;
  byKind: KindCounts;
}

export interface WorkflowSelfCorrections {
  workflowId: string;
  turns: number;
  events: number;
  /** Events per 100 of the workflow's turns. */
  per100Turns: number;
  /** The workflow's turns with at least one self-correction. */
  turnsWithEvents: Share;
  byKind: KindCounts;
}

export interface SelfCorrectionSummary {
  /** Turns read; turns the run-boundary rules left out are not counted. */
  turns: number;
  events: number;
  /** Events per 100 turns; null without turns. */
  per100Turns: number | null;
  /** Turns with at least one self-correction. */
  turnsWithEvents: Share;
  byKind: KindCounts;
  /** Most events first, ties by tool id. */
  byTool: ToolSelfCorrections[];
  /** Events with no call before them (a repeated search before any call, a turn without calls asked again). */
  withoutTool: number;
  /** Only workflows some turn was supplied with; most turns first, ties by id. */
  byWorkflow: WorkflowSelfCorrections[];
  /** Turns read without a workflow id. */
  unplacedTurns: number;
  errors: {
    /** Failed calls behind the error events, each counted once. */
    failedCalls: number;
    /** Failed calls a later call in the turn got past. */
    recovered: Share;
    /** Failed calls in turns the user asked again about, of those in turns where it can be told. */
    askedAgain: Share;
  };
  /** Turns the user asked again about, of the turns where it can be told. */
  askedAgain: Share;
}

export function shareOf(k: number, n: number): Share {
  return { k, n, share: n > 0 ? k / n : null, interval: wilson(k, n) };
}

function countKinds(events: readonly SelfCorrection[]): KindCounts {
  const counts = Object.fromEntries(SELF_CORRECTION_KINDS.map((kind) => [kind, 0])) as KindCounts;
  return events.reduce((acc, event) => ({ ...acc, [event.kind]: acc[event.kind] + 1 }), counts);
}

/** Items by key, in input order; null keys are dropped. The groups are built here, never shared. */
function groupBy<T>(items: readonly T[], keyOf: (item: T) => string | null): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === null) continue;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One reading's failed calls, each once, with what followed. */
function failuresOf(
  reading: SelfCorrectionReading,
): { recovered: boolean; askedAgain: boolean | null }[] {
  const recoveredByCall = new Map<number, boolean>();
  for (const event of reading.events) {
    if (!ERROR_KINDS.has(event.kind) || event.toolOrdinal === null) continue;
    recoveredByCall.set(
      event.toolOrdinal,
      (recoveredByCall.get(event.toolOrdinal) ?? false) || event.recovered === true,
    );
  }
  return [...recoveredByCall.values()].map((recovered) => ({
    recovered,
    askedAgain: reading.askedAgain,
  }));
}

function byWorkflow(readings: readonly SelfCorrectionReading[]): WorkflowSelfCorrections[] {
  return [...groupBy(readings, (r) => r.workflowId ?? null)]
    .map(([workflowId, members]) => {
      const events = members.flatMap((r) => r.events);
      return {
        workflowId,
        turns: members.length,
        events: events.length,
        per100Turns: (events.length * 100) / members.length,
        turnsWithEvents: shareOf(members.filter((r) => r.events.length > 0).length, members.length),
        byKind: countKinds(events),
      };
    })
    .sort((a, b) => b.turns - a.turns || byId(a.workflowId, b.workflowId));
}

/** The summary of every reading given; null entries (turns not read) are skipped. */
export function summarizeSelfCorrections(
  readings: Iterable<SelfCorrectionReading | null | undefined>,
): SelfCorrectionSummary {
  const read = [...readings].filter(
    (r): r is SelfCorrectionReading => r !== null && r !== undefined,
  );
  const events = read.flatMap((r) => r.events);
  const byTool = [...groupBy(events, (e) => e.tool)]
    .map(([tool, own]) => ({ tool, events: own.length, byKind: countKinds(own) }))
    .sort((a, b) => b.events - a.events || byId(a.tool, b.tool));
  const failures = read.flatMap(failuresOf);
  const toldFailures = failures.filter((f) => f.askedAgain !== null);
  const told = read.filter((r) => r.askedAgain !== null);
  return {
    turns: read.length,
    events: events.length,
    per100Turns: read.length > 0 ? (events.length * 100) / read.length : null,
    turnsWithEvents: shareOf(read.filter((r) => r.events.length > 0).length, read.length),
    byKind: countKinds(events),
    byTool,
    withoutTool: events.filter((e) => e.tool === null).length,
    byWorkflow: byWorkflow(read),
    unplacedTurns: read.filter((r) => !r.workflowId).length,
    errors: {
      failedCalls: failures.length,
      recovered: shareOf(failures.filter((f) => f.recovered).length, failures.length),
      askedAgain: shareOf(
        toldFailures.filter((f) => f.askedAgain === true).length,
        toldFailures.length,
      ),
    },
    askedAgain: shareOf(told.filter((r) => r.askedAgain === true).length, told.length),
  };
}
