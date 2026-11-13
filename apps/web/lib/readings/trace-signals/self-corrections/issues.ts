import type { TurnSource } from "@/lib/ledger/types";
import {
  FIX_PATTERNS,
  type FixPattern,
  PLAIN_KINDS,
  type PlainKind,
  type PlainKindCounts,
  zeroPlainCounts,
} from "@/lib/readings/trace-signals/self-corrections/kinds";
import { laneOf, round4 } from "@/lib/readings/trace-signals/signals/build";
import {
  DEFAULT_FLOORS,
  EVIDENCE_TURNS_STORED,
  type Floors,
} from "@/lib/readings/trace-signals/signals/catalog";
import { wilson, wilsonLow } from "@/lib/readings/trace-signals/signals/severity";
import type {
  DetectedSignal,
  DetectionResult,
  MetricValue,
} from "@/lib/readings/trace-signals/signals/types";
import type { SignalFixRoute, SignalKind, TurnSourceMix } from "@/lib/readings/trace-signals/view";

/**
 * The `self_correcting` issue: a tool after which, or a task in whose runs,
 * the agent corrects itself unusually often. Pure: the signal run hands every
 * read turn to {@link createIssueStats} and calls `finish` once.
 *
 * The rate is turns, not events: of the turns that called a tool, those with
 * a self-correction right after one of its calls; of a task's runs, those
 * with any. A subject fires when it has at least `minN` turns and `minK` with
 * a self-correction, and the 95% Wilson lower bound of that share reaches
 * `minLow`. Severity is that bound; impact is the self-corrections counted.
 *
 * The fix follows the subject's most common pattern (`kinds.ts`): failures
 * before it, an empty result before it, a working call it backtracked from,
 * or nothing called at all. A task's fix names the task's tool with the most
 * self-corrections of that pattern, and the unanswered fix names the topic
 * its runs were about, when topics are known.
 */

export const SELF_CORRECTING_KIND = "self_correcting" as const satisfies SignalKind;

/** One self-correction as the issue reads it. */
export interface IssueEvent {
  plain: PlainKind;
  /** The call before it, as a node id (`skill:<id>` for a skill); null when there was none. */
  tool: string | null;
  pattern: FixPattern;
  /** The `trace_events` id of the step it points at, for evidence. */
  traceEventId: string | null;
}

/** One read turn: what it called, where it belongs, and its self-corrections. */
export interface IssueTurn {
  turnId: string;
  endedAt: Date;
  turnSource: TurnSource;
  workflowId: string | null;
  topicId: string | null;
  /** Node ids the turn called, each once. */
  tools: readonly string[];
  events: readonly IssueEvent[];
}

export interface IssueContext {
  /** This run's tasks by id, with their typical order; a task not in it gets no issue. */
  tasks: ReadonlyMap<string, readonly string[]>;
  /** Topic names by id, for the unanswered fix. */
  topics?: ReadonlyMap<string, string>;
  floors?: Floors["self_correcting"];
}

interface Sample {
  turnId: string;
  eventId: string | null;
  at: number;
}

interface SubjectStats {
  turns: number;
  affected: number;
  mix: TurnSourceMix;
  kinds: PlainKindCounts;
  patterns: Record<FixPattern, number>;
  /** Per pattern, self-corrections by the tool before them (tasks name one in the fix). */
  patternTools: Map<FixPattern, Map<string, number>>;
  /** Unanswered self-corrections by the topic of their turn. */
  unansweredTopics: Map<string, number>;
  /** Newest affected turns, at most `EVIDENCE_TURNS_STORED`. */
  samples: Sample[];
}

function emptyStats(): SubjectStats {
  return {
    turns: 0,
    affected: 0,
    mix: { declared: 0, inferred: 0, otlp: 0 },
    kinds: zeroPlainCounts(),
    patterns: { failed: 0, empty: 0, backtrack: 0, unanswered: 0 },
    patternTools: new Map(),
    unansweredTopics: new Map(),
    samples: [],
  };
}

const bump = <K>(map: Map<K, number>, key: K, by = 1): void => {
  map.set(key, (map.get(key) ?? 0) + by);
};

/** Keeps the newest samples, newest first, ties by turn id. */
function keepSample(samples: Sample[], sample: Sample): void {
  samples.push(sample);
  samples.sort((a, b) => b.at - a.at || (a.turnId < b.turnId ? -1 : a.turnId > b.turnId ? 1 : 0));
  if (samples.length > EVIDENCE_TURNS_STORED) samples.length = EVIDENCE_TURNS_STORED;
}

function count(stats: SubjectStats, turn: IssueTurn, events: readonly IssueEvent[]): void {
  stats.turns += 1;
  stats.mix[turn.turnSource] += 1;
  if (events.length === 0) return;
  stats.affected += 1;
  for (const event of events) {
    stats.kinds[event.plain] += 1;
    stats.patterns[event.pattern] += 1;
    if (event.tool !== null) {
      const tools = stats.patternTools.get(event.pattern) ?? new Map<string, number>();
      bump(tools, event.tool);
      stats.patternTools.set(event.pattern, tools);
    }
    if (event.pattern === "unanswered" && turn.topicId) bump(stats.unansweredTopics, turn.topicId);
  }
  keepSample(stats.samples, {
    turnId: turn.turnId,
    eventId: events[0]!.traceEventId,
    at: turn.endedAt.getTime(),
  });
}

/** The most counted key, ties to the smaller key so the answer is stable. */
function top<K extends string>(counts: ReadonlyMap<K, number>): K | null {
  let best: K | null = null;
  for (const [key, n] of counts) {
    const bestN = best === null ? -1 : (counts.get(best) ?? 0);
    if (n > bestN || (n === bestN && best !== null && key < best)) best = key;
  }
  return best;
}

/** The subject's most common pattern; ties go in `FIX_PATTERNS` order. */
function mainPattern(patterns: Record<FixPattern, number>): FixPattern {
  return FIX_PATTERNS.reduce(
    (best, pattern) => (patterns[pattern] > patterns[best] ? pattern : best),
    FIX_PATTERNS[0],
  );
}

const ROUTES: Readonly<Record<FixPattern, SignalFixRoute>> = {
  failed: "show_turns",
  empty: "workflow_skill",
  backtrack: "rewrite_description",
  unanswered: "workflow_skill",
};

/** The metric key of each plain kind. */
export const PLAIN_KIND_METRICS: Readonly<Record<PlainKind, string>> = {
  retried: "retried",
  switched: "switched",
  gave_up: "gaveUp",
  searched_again: "searchedAgain",
  asked_again: "askedAgain",
  apologized: "apologized",
  conceded: "conceded",
  backtracked: "backtracked",
};

/** A node id's catalog id and kind: `skill:<id>` is a skill, anything else a tool. */
export function catalogEntryOf(node: string): { id: string; kind: "tool" | "skill" } {
  return node.startsWith("skill:")
    ? { id: node.slice("skill:".length), kind: "skill" }
    : { id: node, kind: "tool" };
}

function metricsOf(
  stats: SubjectStats,
  pattern: FixPattern,
  fixTool: string | null,
  topic: { id: string | null; name: string | null },
): Record<string, MetricValue> {
  const interval = wilson(stats.affected, stats.turns);
  const events = PLAIN_KINDS.reduce((sum, kind) => sum + stats.kinds[kind], 0);
  return {
    k: stats.affected,
    n: stats.turns,
    share: round4(stats.affected / Math.max(1, stats.turns)),
    low: round4(interval?.low ?? 0),
    high: round4(interval?.high ?? 1),
    events,
    ...Object.fromEntries(PLAIN_KINDS.map((kind) => [PLAIN_KIND_METRICS[kind], stats.kinds[kind]])),
    pattern,
    patternEvents: stats.patterns[pattern],
    fixTool,
    topicId: topic.id,
    topicName: topic.name,
  };
}

function fires(stats: SubjectStats, floors: Floors["self_correcting"]): boolean {
  return (
    stats.turns >= floors.minN &&
    stats.affected >= floors.minK &&
    wilsonLow(stats.affected, stats.turns) >= floors.minLow
  );
}

function evidence(stats: SubjectStats) {
  return {
    turnIds: stats.samples.map((s) => s.turnId),
    traceEventIds: stats.samples.map((s) => s.eventId),
    totalTurns: stats.affected,
    turnSourceMix: { ...stats.mix },
  };
}

function toolSignal(node: string, stats: SubjectStats): DetectedSignal {
  const entry = catalogEntryOf(node);
  const pattern = mainPattern(stats.patterns);
  return {
    kind: SELF_CORRECTING_KIND,
    subjectKind: entry.kind === "skill" ? "skill" : "tool",
    subjectKey: node,
    subjectIds: [entry.id],
    entryKind: entry.kind,
    lane: laneOf(stats.mix),
    severity: round4(wilsonLow(stats.affected, stats.turns)),
    impact: PLAIN_KINDS.reduce((sum, kind) => sum + stats.kinds[kind], 0),
    n: stats.turns,
    route: ROUTES[pattern],
    metrics: metricsOf(stats, pattern, node, { id: null, name: null }),
    evidence: evidence(stats),
  };
}

function taskSignal(
  id: string,
  order: readonly string[],
  stats: SubjectStats,
  topics: ReadonlyMap<string, string>,
): DetectedSignal {
  const pattern = mainPattern(stats.patterns);
  const fixTool =
    pattern === "unanswered" ? null : top(stats.patternTools.get(pattern) ?? new Map());
  const topicId = pattern === "unanswered" ? top(stats.unansweredTopics) : null;
  return {
    kind: SELF_CORRECTING_KIND,
    subjectKind: "workflow",
    subjectKey: id,
    subjectIds: [...order],
    entryKind: "tool",
    lane: laneOf(stats.mix),
    severity: round4(wilsonLow(stats.affected, stats.turns)),
    impact: PLAIN_KINDS.reduce((sum, kind) => sum + stats.kinds[kind], 0),
    n: stats.turns,
    route: ROUTES[pattern],
    metrics: metricsOf(stats, pattern, fixTool, {
      id: topicId,
      name: topicId ? (topics.get(topicId) ?? null) : null,
    }),
    evidence: evidence(stats),
    subjectDetail: { typicalOrder: [...order] },
  };
}

export interface IssueStats {
  add(turn: IssueTurn): void;
  finish(context: IssueContext): DetectionResult;
}

/** Counts every read turn once; `finish` emits the issues, worst first. */
export function createIssueStats(): IssueStats {
  const tools = new Map<string, SubjectStats>();
  const tasks = new Map<string, SubjectStats>();
  return {
    add(turn) {
      for (const node of turn.tools) {
        const stats = tools.get(node) ?? emptyStats();
        count(
          stats,
          turn,
          turn.events.filter((event) => event.tool === node),
        );
        tools.set(node, stats);
      }
      if (turn.workflowId) {
        const stats = tasks.get(turn.workflowId) ?? emptyStats();
        count(stats, turn, turn.events);
        tasks.set(turn.workflowId, stats);
      }
    },
    finish(context) {
      const floors = context.floors ?? DEFAULT_FLOORS.self_correcting;
      const topics = context.topics ?? new Map<string, string>();
      const signals = [
        ...[...tools]
          .filter(([, stats]) => fires(stats, floors))
          .map(([node, stats]) => toolSignal(node, stats)),
        ...[...tasks]
          .filter(([id, stats]) => context.tasks.has(id) && fires(stats, floors))
          .map(([id, stats]) => taskSignal(id, context.tasks.get(id) ?? [], stats, topics)),
      ].sort(
        (a, b) =>
          b.severity - a.severity || b.impact - a.impact || (a.subjectKey < b.subjectKey ? -1 : 1),
      );
      return { signals, measured: new Set<SignalKind>([SELF_CORRECTING_KIND]) };
    },
  };
}
