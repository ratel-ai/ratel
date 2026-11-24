import { leadingStreak } from "@/lib/readings/trace-signals/outcomes/followed";
import {
  REPLY_REACTIONS,
  type ReplyReaction,
  SATISFACTIONS,
  type Satisfaction,
  SESSION_OUTCOMES,
  type SessionOutcome,
  type StoredFailureStreak,
  TASK_REASONS,
  TASK_TIERS,
  type TaskReason,
  type TaskTier,
} from "@/lib/readings/trace-signals/outcomes/kinds";
import type { WindowDays } from "@/lib/readings/trace-signals/view";
import { buildOverview, emptyOverview, type Overview } from "@/lib/views/traces/sentiment/overview";
import {
  BLAMELESS_CAUSES,
  CAUSE_OWNER,
  type CauseOwner,
  countsOf,
  type RootCause,
  rootCauseOf,
  STORED_REACTIONS,
  type StoredReaction,
  sessionOutcomeOf,
} from "@/lib/views/traces/sentiment/page-kinds";
import {
  type SentimentFilters,
  type SentimentQuery,
  type SentimentSort,
  TASK_FILTERS,
  type TaskFilter,
  taskFilterOf,
} from "@/lib/views/traces/sentiment/page-paths";

export { taskFilterOf };

/**
 * The Sentiment analysis page, built from stored outcome rows. Pure: rows in,
 * the page out, no I/O and no clock.
 *
 * The page leads with root causes. A root cause is something that went wrong
 * in a turn: a failure streak (its tool and why its calls failed), a search
 * no listed tool fits, or, where the person's words were read, a turn
 * they were not satisfied with although every call worked. A row is one
 * intent, one cause and one tool. Its unit is the session: how many sessions
 * it happened in, and in how many of those it was not recovered from (no later
 * call in the turn worked) or left the person unsatisfied.
 *
 * Rows seen in fewer sessions than the minimum are hidden and counted, since
 * a share of two sessions says nothing. Trends are weekly (weeks start on
 * Monday, UTC): a project with a handful of sessions a day has empty days.
 *
 * Filters narrow the root causes; each cut is counted under every filter but
 * its own, so picking a value never empties the list it was picked from.
 *
 * Rows are grouped by cause, groups and their rows in the order asked for, and
 * listed a page at a time. Each row and group carries the time its turns took
 * and, where the agent sent its model calls, what they cost.
 */

/** The intent filter's value for turns the engine placed nowhere. */
export const NO_INTENT = "none";
/**
 * The intent of a folded row: rows under the minimum that share a cause and a
 * tool are counted together, so a project whose asks spread over many intents
 * still ranks its causes.
 */
export const OTHER_INTENTS: PageIntent = { id: "other", label: "Other intents" };
/** Root cause rows per page. */
export const PAGE_ROWS = 20;
/** Intents listed on each side of the satisfaction ranking. */
export const INTENT_SCORE_TOP = 5;
/** Values listed per cut at most. */
export const MAX_CUT_VALUES = 8;
/** Example sessions a row carries. */
export const ROW_SESSIONS = 5;

/** A turn with something to explain, as `trace_turn_outcomes` holds it. */
export interface PageTurn {
  turnId: string;
  sessionId: string;
  startedAt: Date;
  endedAt: Date;
  /** What the turn's model calls cost; null when none of them was sent with a cost. */
  costUsd: number | null;
  cause: string | null;
  causeSource: string | null;
  failures: readonly StoredFailureStreak[];
  unmetSearches: number;
  satisfaction: string | null;
  reaction: string | null;
}

/** A session as `trace_session_outcomes` holds it. */
export interface PageSession {
  sessionId: string;
  outcome: string | null;
  outcomeSource: string | null;
  frictionCount: number;
  openRequest: boolean;
  endedAt: Date;
}

/** A task as `trace_task_outcomes` holds it. */
export interface TaskFriction {
  extraTurns: number;
  /** Tokens the friction used; null when no model call was sent with them. */
  tokens: number | null;
  /** Calls that failed and were tried again in the turn that finished it. */
  retriedCalls: number;
  costUsd: number | null;
  timeMs: number;
}

export interface PageTask {
  taskId: string;
  sessionId: string;
  turnIds: string[];
  startedAt: Date;
  endedAt: Date;
  /** What the model calls of its turns cost; null when none was sent with a cost. */
  costUsd: number | null;
  /** Tokens its model calls used (input and output); null when none was sent with them. */
  tokens: number | null;
  /**
   * For a task completed after friction, what the friction spent: the turns
   * before the one that finished it, whole, and in that last turn the calls
   * that failed before one worked (their time and the wait after each, their
   * share of the turn's model cost: an estimate). Cost is null without a
   * costed call. Null for any other task.
   */
  friction: TaskFriction | null;
  tier: string;
  goalSource: string;
  result: string;
  reason: string | null;
  cause: string | null;
  checked: boolean;
}

/** A turn the person said how it went: satisfied or not. Neutral and undecided turns are not answers here. */
export interface PageAnswer {
  turnId: string;
  sessionId: string;
  satisfied: boolean;
  /** When the turn ended: the day it counts on. Absent counts as never on any day. */
  endedAt?: Date;
  /** Read from the agent's next reply, not the person's own words. */
  inferred?: boolean;
}

export interface PageIntent {
  id: string;
  label: string;
}

export interface SentimentPageInput {
  projectId: string;
  windowDays: WindowDays;
  now: Date;
  /** The window's turns with a failed call, an unmet search or an unsatisfied person. */
  turns: readonly PageTurn[];
  sessions: readonly PageSession[];
  /** The window's turns the person said how it went. */
  answers: readonly PageAnswer[];
  /** The window's tasks. */
  tasks: readonly PageTask[];
  /** The intent of each of those turns (and of the answered ones) the engine placed. */
  intents: ReadonlyMap<string, PageIntent>;
  /** The catalog version each of those turns ran on, where the SDK sent one. */
  versions: ReadonlyMap<string, string>;
  /** Over every turn row of the window. */
  totals: {
    turns: number;
    /** Turns a model answered about. */
    answered: number;
    /** Turn rows whose turn sent the person's message. */
    textTurns: number;
    /** Messages sent in the window, with or without a turn row. */
    messages: number;
    satisfaction: Readonly<Record<string, number>>;
    reactions: Readonly<Record<string, number>>;
    /** How people took turns as the agent's next reply shows it; absent counts as none. */
    replyReactions?: Readonly<Record<string, number>>;
  };
  /** A key for the model is set. */
  modelConfigured: boolean;
  /** The window holds model calls sent with a cost, so cost can be shown and ordered by. */
  costKnown: boolean;
  /** The window held more turns or sessions than were read. */
  capped: boolean;
  minSessions: number;
}

/** One session of a row, by the turn it happened in. Ids and a time only. */
export interface RowExample {
  sessionId: string;
  turnId: string;
  at: string;
  unresolved: boolean;
}

/** How a number was read: by a rule on the trace, by a model, or by both. */
export type ReadBy = "rule" | "model" | "mixed";

export interface RootCauseRow {
  /** Stable for the same intent, cause and tool: the row's address in the URL. */
  key: string;
  intent: PageIntent | null;
  cause: RootCause;
  owner: CauseOwner;
  readBy: ReadBy;
  /** A node id (a skill as `skill:<id>`); null when the cause has no tool. */
  tool: string | null;
  sessions: number;
  turns: number;
  failedCalls: number;
  /** Sessions where it was not recovered from, or the person was unsatisfied. */
  unresolved: number;
  unresolvedShare: number;
  /** Turns of the row a model answered about, and what the person did next. */
  answered: number;
  unsatisfied: number;
  reactions: Partial<Record<StoredReaction, number>>;
  /** What the model calls of its turns cost; null when the window holds no costed model call. */
  costUsd: number | null;
  /** How long its turns took, end to end. */
  timeMs: number;
  /** Sessions per week, aligned to the page's `weeks`. */
  trend: number[];
  firstSeen: string;
  lastSeen: string;
  /** The catalog version of its first turn in the window; null when none was sent. */
  startedVersion: string | null;
  /** A few of its sessions, each by its latest turn of the row: unresolved ones first, then newest first. */
  examples: RowExample[];
  /** Under the minimum count: listed only when thin rows are asked for. */
  thin: boolean;
}

export interface CutValue {
  key: string;
  label: string;
  /** Sessions with a root cause here. */
  sessions: number;
  unresolved: number;
  share: number;
  active: boolean;
}

export interface Cut {
  values: CutValue[];
  /** Values not listed. */
  more: number;
}

/** Every row of one cause, counted together: a session or a turn in two of its rows counts once. */
export interface CauseGroup {
  cause: RootCause;
  owner: CauseOwner;
  readBy: ReadBy;
  sessions: number;
  unresolved: number;
  unresolvedShare: number;
  costUsd: number | null;
  timeMs: number;
  lastSeen: string;
  /** Its rows on every page. */
  rowCount: number;
}

/** A group as one page lists it: the group's totals, and its rows that fall on this page. */
export interface PageGroup extends CauseGroup {
  rows: RootCauseRow[];
  /** Its first rows are on an earlier page. */
  continued: boolean;
}

export interface InferredReactions {
  /** Turns a reply showed a reaction for. */
  turns: number;
  reactions: Record<ReplyReaction, number>;
  /** Satisfied of those turns; null when none showed satisfied or unsatisfied. */
  score: number | null;
}

/** What the agent's replies show, counted; null when they showed nothing. */
function inferredOf(
  counts: Readonly<Record<string, number>> | undefined,
): InferredReactions | null {
  const reactions = Object.fromEntries(
    REPLY_REACTIONS.map((reaction) => [reaction, counts?.[reaction] ?? 0]),
  ) as Record<ReplyReaction, number>;
  const turns = REPLY_REACTIONS.reduce((sum, reaction) => sum + reactions[reaction], 0);
  if (turns === 0) return null;
  const unhappy = reactions.corrects + reactions.repeats + reactions.asks_human;
  const said = reactions.satisfied + unhappy;
  return { turns, reactions, score: said === 0 ? null : reactions.satisfied / said };
}

/** One intent's satisfaction: satisfied of the turns people said how it went. */
export interface IntentScore {
  intent: PageIntent;
  score: number;
  satisfied: number;
  said: number;
}

export interface IntentScores {
  /** Up to `INTENT_SCORE_TOP` intents scoring above one half, the highest first. */
  satisfied: IntentScore[];
  /** Up to `INTENT_SCORE_TOP` intents scoring below one half, the lowest first. */
  unsatisfied: IntentScore[];
  /** An intent with fewer answers than this is ranked but marked: its score is a hint. */
  fewAnswers: number;
}

export interface TaskSplit {
  total: number;
  classes: Array<{ filter: TaskFilter; tasks: number; share: number }>;
  /** Of the tasks not completed, by reason, most first; reasons with none are left out. */
  reasons: Array<{ reason: TaskReason; tasks: number; share: number }>;
  /** Tasks by how much their result could be read from. */
  tiers: Record<TaskTier, number>;
}

export interface PageInfo {
  /** This page, from 1; a page past the end reads as the last. */
  page: number;
  pages: number;
  size: number;
  /** Rows on every page. */
  total: number;
  /** 1-based positions of this page's first and last row; 0 when there are none. */
  from: number;
  to: number;
}

export type TextState = "no_text" | "model_off" | "capped" | "read";

export interface SentimentPageModel {
  projectId: string;
  windowDays: WindowDays;
  state: "ready" | "empty" | "unavailable";
  query: SentimentQuery;
  /** The Monday of each week of the window, oldest first. */
  weeks: string[];
  totals: {
    /** Sessions read in the window; under a filter, the sessions it matches. */
    sessions: number;
    turns: number;
    /** Sessions with a root cause. */
    affected: number;
    unresolved: number;
  };
  split: {
    total: number;
    classes: Array<{
      outcome: SessionOutcome;
      sessions: number;
      share: number;
      /** Satisfied of the turns people said how it went in sessions that ended this way; null when nobody did. */
      score: number | null;
      /** Those turns. */
      said: number;
    }>;
    readBy: ReadBy;
  };
  text: {
    state: TextState;
    textTurns: number;
    /** Turns a model answered any question about. */
    answeredTurns: number;
    /** Turns with a satisfaction answer: what the satisfaction counts add up to. A turn can be answered and have none. */
    satisfactionTurns: number;
    satisfaction: Record<Satisfaction, number> | null;
    /** Satisfied turns of those the person said how it went (satisfied or unsatisfied); null when there are none. */
    score: number | null;
    reactions: Record<StoredReaction, number> | null;
    /**
     * How people took turns, inferred from the agent's next reply where their
     * own words were not read (`reply-reading.ts`); null when no reply showed it.
     */
    inferred: InferredReactions | null;
  };
  /** The rows on this page, in the order listed. */
  rows: RootCauseRow[];
  /** The rows on this page by cause, each with its group's totals. */
  groups: PageGroup[];
  pagination: PageInfo;
  /** Intents by satisfaction score; null when people's messages were not read and no reply showed how they took it. */
  intentScores: IntentScores | null;
  /** What the window's tasks came to, under the intent, session-outcome and week filters. */
  tasks: TaskSplit;
  /** The page's answer over those tasks: completion, satisfaction, the reasons and their root causes, day by day (`overview.ts`). */
  overview: Overview;
  /** The row with the most sessions left unresolved, on any page. */
  top: RootCauseRow | null;
  /** Model calls were sent with a cost: the cost column and order show. */
  costKnown: boolean;
  minSessions: number;
  /** Rows under the minimum count, the sessions only they hold, and the thin rows folded into "Other intents" rows. */
  hidden: { rows: number; sessions: number; folded: number };
  /** An intent, a session outcome or a task filter narrows the page to a slice: every row of it shows, however few sessions. */
  thinForced: boolean;
  cuts: { intent: Cut; tool: Cut; week: Cut; version: Cut };
  capped: boolean;
}

const DAY_MS = 86_400_000;

/** The Monday (UTC) of the week `date` is in, as `YYYY-MM-DD`. */
export function weekOf(date: Date): string {
  const day = (date.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day))
    .toISOString()
    .slice(0, 10);
}

/** Every week from the one `from` is in to the one `to` is in. */
export function weeksBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  const end = Date.parse(weekOf(to));
  for (let at = Date.parse(weekOf(from)); at <= end; at += 7 * DAY_MS)
    out.push(new Date(at).toISOString().slice(0, 10));
  return out;
}

export function rowKey(intent: string | null, cause: RootCause, tool: string | null): string {
  return [intent ?? NO_INTENT, cause, tool ?? ""].map(encodeURIComponent).join("|");
}

/** The intent, cause and tool a row key names; null when it is no row key. */
export function parseRowKey(
  key: string,
): { intent: string | null; cause: RootCause; tool: string | null } | null {
  const parts = key.split("|");
  if (parts.length !== 3) return null;
  try {
    const [intent, cause, tool] = parts.map(decodeURIComponent) as [string, string, string];
    const known = rootCauseOf(cause);
    if (!intent || known !== cause) return null;
    return { intent: intent === NO_INTENT ? null : intent, cause: known, tool: tool || null };
  } catch {
    return null;
  }
}

/** One thing that went wrong in one turn. */
export interface Occurrence {
  turn: PageTurn;
  cause: RootCause;
  source: ReadBy;
  tool: string | null;
  errors: number;
  /** Not recovered from, or the person was unsatisfied. Never for a cause that is not the agent's doing. */
  unresolved: boolean;
}

/**
 * What went wrong in a turn, one occurrence per cause and tool:
 *   - each failure streak, under the cause the rules sorted its errors into.
 *     A streak the rules left open takes the cause a model chose for the
 *     turn, when it is the turn's leading failure (the one the model was
 *     asked about);
 *   - a search no listed tool fits: no fitting tool, the same cause a
 *     model names when the agent says it cannot do something;
 *   - a cause a model chose for a turn in which no streak took it: a turn
 *     that went wrong with every call working;
 *   - with none of these, a turn the person was not satisfied with.
 * A correct refusal is listed and never unresolved: the agent was right.
 */
export function occurrencesOf(turn: PageTurn): Occurrence[] {
  const unsatisfied = turn.satisfaction === "unsatisfied";
  const modelCause = turn.causeSource === "model" ? rootCauseOf(turn.cause) : null;
  const leading = leadingStreak(turn.failures);
  const out = new Map<string, Occurrence>();
  const add = (next: Omit<Occurrence, "turn">) => {
    const key = `${next.cause}\u0000${next.tool ?? ""}`;
    const seen = out.get(key);
    const occurrence = {
      ...next,
      unresolved: next.unresolved && !BLAMELESS_CAUSES.includes(next.cause),
    };
    if (!seen) out.set(key, { turn, ...occurrence });
    else {
      out.set(key, {
        ...seen,
        errors: seen.errors + occurrence.errors,
        unresolved: seen.unresolved || occurrence.unresolved,
        source: seen.source === occurrence.source ? seen.source : "mixed",
      });
    }
  };
  let taken = false;
  for (const streak of turn.failures) {
    const open = streak.cause === null || streak.cause === "other";
    const byModel = open && streak === leading && modelCause !== null;
    if (byModel) taken = true;
    add({
      cause: byModel ? modelCause : (streak.cause ?? "unread"),
      source: byModel ? "model" : "rule",
      tool: streak.tool,
      errors: streak.errors,
      unresolved: !streak.recovered || unsatisfied,
    });
  }
  if (turn.unmetSearches > 0) {
    add({
      cause: "missing_capability",
      source: "rule",
      tool: null,
      errors: 0,
      unresolved: turn.satisfaction !== "satisfied",
    });
  }
  if (modelCause !== null && !taken) {
    add({ cause: modelCause, source: "model", tool: null, errors: 0, unresolved: true });
  } else if (out.size === 0 && unsatisfied) {
    add({ cause: "no_failure", source: "model", tool: null, errors: 0, unresolved: true });
  }
  return [...out.values()];
}

interface Placed extends Occurrence {
  intent: PageIntent | null;
  /** How its session ended; null when the session is outside what was read. */
  outcome: SessionOutcome | null;
  /** What its task came to and why; null when its task is outside what was read. */
  task: TaskFilter | null;
  reason: TaskReason | null;
  version: string | null;
  week: string;
}

type Dimension = keyof SentimentFilters;

function matches(occurrence: Placed, filters: SentimentFilters, skip?: Dimension): boolean {
  const on = (dimension: Dimension) => dimension !== skip && filters[dimension] !== null;
  if (on("intent") && (occurrence.intent?.id ?? NO_INTENT) !== filters.intent) return false;
  if (on("cause") && occurrence.cause !== filters.cause) return false;
  if (on("tool") && occurrence.tool !== filters.tool) return false;
  if (on("week") && occurrence.week !== filters.week) return false;
  if (on("version") && occurrence.version !== filters.version) return false;
  if (on("outcome") && occurrence.outcome !== filters.outcome) return false;
  if (on("task") && occurrence.task !== filters.task) return false;
  if (on("reason") && occurrence.reason !== filters.reason) return false;
  return true;
}

const share = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);
const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** What a row and a group are both ordered by. */
type Ranked = Pick<
  RootCauseRow,
  "sessions" | "unresolved" | "unresolvedShare" | "costUsd" | "timeMs" | "lastSeen"
>;

const SORTS: Record<SentimentSort, (a: Ranked, b: Ranked) => number> = {
  impact: (a, b) => b.unresolved - a.unresolved || b.sessions - a.sessions,
  sessions: (a, b) => b.sessions - a.sessions || b.unresolved - a.unresolved,
  share: (a, b) => b.unresolvedShare - a.unresolvedShare || b.sessions - a.sessions,
  cost: (a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.unresolved - a.unresolved,
  time: (a, b) => b.timeMs - a.timeMs || b.unresolved - a.unresolved,
  recent: (a, b) => text(b.lastSeen, a.lastSeen) || b.sessions - a.sessions,
};

/** How long a turn took, end to end; never negative on a skewed clock. */
const durationOf = (turn: PageTurn): number =>
  Math.max(0, turn.endedAt.getTime() - turn.startedAt.getTime());

/** The cost and time of a set of turns, each turn once. */
function spendOf(
  turns: Iterable<PageTurn>,
  costKnown: boolean,
): { costUsd: number | null; timeMs: number } {
  let costUsd = 0;
  let timeMs = 0;
  for (const turn of turns) {
    costUsd += turn.costUsd ?? 0;
    timeMs += durationOf(turn);
  }
  return { costUsd: costKnown ? costUsd : null, timeMs };
}

function readBy(rule: number, model: number): ReadBy {
  return model === 0 ? "rule" : rule === 0 ? "model" : "mixed";
}

const exactKey = (occurrence: Placed): string =>
  rowKey(occurrence.intent?.id ?? null, occurrence.cause, occurrence.tool);

/**
 * Thin rows that share a cause and a tool, folded: when two or more of them
 * together reach the minimum, their occurrences take the "Other intents"
 * intent. Returns the occurrences as they are to be grouped, and how many
 * rows were folded.
 */
function foldThin(
  placed: readonly Placed[],
  minSessions: number,
): { placed: Placed[]; folded: number } {
  const sessionsOf = new Map<string, Set<string>>();
  for (const occurrence of placed) {
    const key = exactKey(occurrence);
    const set = sessionsOf.get(key) ?? new Set<string>();
    sessionsOf.set(key, set);
    set.add(occurrence.turn.sessionId);
  }
  const thin = (occurrence: Placed) =>
    (sessionsOf.get(exactKey(occurrence))?.size ?? 0) < minSessions;
  const pools = new Map<string, { rows: Set<string>; sessions: Set<string> }>();
  for (const occurrence of placed) {
    if (!thin(occurrence)) continue;
    const key = rowKey(OTHER_INTENTS.id, occurrence.cause, occurrence.tool);
    const pool = pools.get(key) ?? { rows: new Set<string>(), sessions: new Set<string>() };
    pools.set(key, pool);
    pool.rows.add(exactKey(occurrence));
    pool.sessions.add(occurrence.turn.sessionId);
  }
  const folds = (occurrence: Placed) => {
    const pool = pools.get(rowKey(OTHER_INTENTS.id, occurrence.cause, occurrence.tool));
    return (
      thin(occurrence) &&
      pool !== undefined &&
      pool.rows.size > 1 &&
      pool.sessions.size >= minSessions
    );
  };
  const foldedRows = new Set<string>();
  const out = placed.map((occurrence) => {
    if (!folds(occurrence)) return occurrence;
    foldedRows.add(exactKey(occurrence));
    return { ...occurrence, intent: OTHER_INTENTS };
  });
  return { placed: out, folded: foldedRows.size };
}

function buildRows(
  placed: readonly Placed[],
  weeks: readonly string[],
  minSessions: number,
  costKnown: boolean,
): RootCauseRow[] {
  const groups = new Map<string, Placed[]>();
  for (const occurrence of placed) {
    const key = exactKey(occurrence);
    const list = groups.get(key);
    if (list) list.push(occurrence);
    else groups.set(key, [occurrence]);
  }
  const weekIndex = new Map(weeks.map((week, index) => [week, index]));
  return [...groups].map(([key, list]) => {
    const first = list.reduce((a, b) => (b.turn.endedAt < a.turn.endedAt ? b : a));
    const last = list.reduce((a, b) => (b.turn.endedAt > a.turn.endedAt ? b : a));
    const sessions = new Map<string, { unresolved: boolean; last: number; turnId: string }>();
    const weekly = weeks.map(() => new Set<string>());
    const reactions: Partial<Record<StoredReaction, number>> = {};
    let answered = 0;
    let unsatisfied = 0;
    for (const occurrence of list) {
      const { turn } = occurrence;
      const seen = sessions.get(turn.sessionId);
      const later = !seen || turn.endedAt.getTime() >= seen.last;
      sessions.set(turn.sessionId, {
        unresolved: (seen?.unresolved ?? false) || occurrence.unresolved,
        last: later ? turn.endedAt.getTime() : seen.last,
        turnId: later ? turn.turnId : seen.turnId,
      });
      weekly[weekIndex.get(occurrence.week) ?? -1]?.add(turn.sessionId);
      if (turn.satisfaction !== null || turn.reaction !== null) answered += 1;
      if (turn.satisfaction === "unsatisfied") unsatisfied += 1;
      const reaction = STORED_REACTIONS.find((known) => known === turn.reaction);
      if (reaction) reactions[reaction] = (reactions[reaction] ?? 0) + 1;
    }
    const unresolved = [...sessions.values()].filter((session) => session.unresolved).length;
    const cause = first.cause;
    return {
      key,
      intent: first.intent,
      cause,
      owner: CAUSE_OWNER[cause],
      readBy: readBy(
        list.filter((o) => o.source !== "model").length,
        list.filter((o) => o.source !== "rule").length,
      ),
      tool: first.tool,
      sessions: sessions.size,
      turns: list.length,
      failedCalls: list.reduce((total, occurrence) => total + occurrence.errors, 0),
      unresolved,
      unresolvedShare: share(unresolved, sessions.size),
      answered,
      unsatisfied,
      reactions,
      ...spendOf(new Set(list.map((occurrence) => occurrence.turn)), costKnown),
      trend: weekly.map((set) => set.size),
      firstSeen: first.turn.endedAt.toISOString(),
      lastSeen: last.turn.endedAt.toISOString(),
      startedVersion: first.version,
      examples: [...sessions]
        .sort(
          (a, b) =>
            Number(b[1].unresolved) - Number(a[1].unresolved) ||
            b[1].last - a[1].last ||
            text(a[0], b[0]),
        )
        .slice(0, ROW_SESSIONS)
        .map(([sessionId, seen]) => ({
          sessionId,
          turnId: seen.turnId,
          at: new Date(seen.last).toISOString(),
          unresolved: seen.unresolved,
        })),
      thin: sessions.size < minSessions,
    };
  });
}

/** The listed rows' occurrences by cause, counted as groups. */
function buildGroups(
  placed: readonly Placed[],
  rows: readonly RootCauseRow[],
  costKnown: boolean,
): CauseGroup[] {
  const listed = new Set(rows.map((row) => row.key));
  const rowCount = new Map<RootCause, number>();
  for (const row of rows) rowCount.set(row.cause, (rowCount.get(row.cause) ?? 0) + 1);
  const byCause = new Map<RootCause, Placed[]>();
  for (const occurrence of placed) {
    if (!listed.has(exactKey(occurrence))) continue;
    const list = byCause.get(occurrence.cause);
    if (list) list.push(occurrence);
    else byCause.set(occurrence.cause, [occurrence]);
  }
  return [...byCause].map(([cause, list]) => {
    const sessions = new Set(list.map((occurrence) => occurrence.turn.sessionId));
    const unresolved = new Set(
      list
        .filter((occurrence) => occurrence.unresolved)
        .map((occurrence) => occurrence.turn.sessionId),
    );
    const last = list.reduce((a, b) => (b.turn.endedAt > a.turn.endedAt ? b : a));
    return {
      cause,
      owner: CAUSE_OWNER[cause],
      readBy: readBy(
        list.filter((o) => o.source !== "model").length,
        list.filter((o) => o.source !== "rule").length,
      ),
      sessions: sessions.size,
      unresolved: unresolved.size,
      unresolvedShare: share(unresolved.size, sessions.size),
      ...spendOf(new Set(list.map((occurrence) => occurrence.turn)), costKnown),
      lastSeen: last.turn.endedAt.toISOString(),
      rowCount: rowCount.get(cause) ?? 0,
    };
  });
}

/** The groups in order, each with its rows in order, cut to one page. */
function paginate(
  groups: readonly CauseGroup[],
  rows: readonly RootCauseRow[],
  requested: number,
): { groups: PageGroup[]; rows: RootCauseRow[]; info: PageInfo } {
  const ordered = groups.flatMap((group) => rows.filter((row) => row.cause === group.cause));
  const pages = Math.max(1, Math.ceil(ordered.length / PAGE_ROWS));
  const page = Math.min(Math.max(1, requested), pages);
  const start = (page - 1) * PAGE_ROWS;
  const onPage = ordered.slice(start, start + PAGE_ROWS);
  const before = new Set(ordered.slice(0, start).map((row) => row.cause));
  const listed: PageGroup[] = groups.flatMap((group) => {
    const own = onPage.filter((row) => row.cause === group.cause);
    return own.length > 0 ? [{ ...group, rows: own, continued: before.has(group.cause) }] : [];
  });
  return {
    groups: listed,
    rows: onPage,
    info: {
      page,
      pages,
      size: PAGE_ROWS,
      total: ordered.length,
      from: onPage.length > 0 ? start + 1 : 0,
      to: start + onPage.length,
    },
  };
}

/**
 * The intents people were most and least satisfied with, from the turns they
 * said how it went in: every intent with an answer is ranked, five a side, and
 * on equal scores the one with more answers comes first. One scoring exactly
 * one half is on neither side. Fewer answers than `fewAnswers` mark a score as
 * a hint, not a pattern.
 */
function intentScoresOf(
  answers: readonly PageAnswer[],
  intents: ReadonlyMap<string, PageIntent>,
  fewAnswers: number,
): IntentScores {
  const byIntent = new Map<string, { intent: PageIntent; satisfied: number; said: number }>();
  for (const answer of answers) {
    const intent = intents.get(answer.turnId);
    if (!intent) continue;
    const entry = byIntent.get(intent.id) ?? { intent, satisfied: 0, said: 0 };
    byIntent.set(intent.id, entry);
    entry.said += 1;
    if (answer.satisfied) entry.satisfied += 1;
  }
  const ranked = [...byIntent.values()].map((entry) => ({
    ...entry,
    score: entry.satisfied / entry.said,
  }));
  const byScore = (a: IntentScore, b: IntentScore) =>
    b.score - a.score || b.said - a.said || text(a.intent.label, b.intent.label);
  return {
    satisfied: ranked
      .filter((entry) => entry.score > 0.5)
      .sort(byScore)
      .slice(0, INTENT_SCORE_TOP),
    unsatisfied: ranked
      .filter((entry) => entry.score < 0.5)
      .sort((a, b) => a.score - b.score || b.said - a.said || text(a.intent.label, b.intent.label))
      .slice(0, INTENT_SCORE_TOP),
    fewAnswers,
  };
}

/**
 * What the window's tasks came to, under the filters a task has: its intent
 * (its first turn's), how its session ended and the week it ended. The turn
 * filters (cause, tool, catalog version) and its own (result, reason) do not
 * apply, so picking a result never empties the split it was picked from.
 */
/** The window's tasks under the intent (of the task's first turn), session-outcome and week filters. */
function scopedTasks(
  input: SentimentPageInput,
  filters: SentimentFilters,
  outcomeOf: ReadonlyMap<string, SessionOutcome>,
): PageTask[] {
  return input.tasks.filter((task) => {
    if (
      filters.intent !== null &&
      (input.intents.get(task.taskId)?.id ?? NO_INTENT) !== filters.intent
    )
      return false;
    if (filters.outcome !== null && outcomeOf.get(task.sessionId) !== filters.outcome) return false;
    if (filters.week !== null && weekOf(task.endedAt) !== filters.week) return false;
    return true;
  });
}

function taskSplitOf(tasks: readonly PageTask[]): TaskSplit {
  const filtersOf = tasks.map(taskFilterOf);
  const notCompleted = tasks.filter((task) => task.result === "not_completed");
  const tiers = Object.fromEntries(TASK_TIERS.map((tier) => [tier, 0])) as Record<TaskTier, number>;
  for (const task of tasks) {
    const tier = TASK_TIERS.find((known) => known === task.tier);
    if (tier) tiers[tier] += 1;
  }
  return {
    total: tasks.length,
    classes: TASK_FILTERS.map((filter) => {
      const n = filtersOf.filter((value) => value === filter).length;
      return { filter, tasks: n, share: share(n, tasks.length) };
    }),
    reasons: TASK_REASONS.map((reason) => {
      const n = notCompleted.filter((task) => task.reason === reason).length;
      return { reason, tasks: n, share: share(n, notCompleted.length) };
    })
      .filter((entry) => entry.tasks > 0)
      .sort((a, b) => b.tasks - a.tasks || text(a.reason, b.reason)),
    tiers,
  };
}

/** Satisfied of the turns the person said how it went; null when nobody did. */
function scoreOf(satisfaction: Record<Satisfaction, number> | null): number | null {
  if (!satisfaction) return null;
  const said = satisfaction.satisfied + satisfaction.unsatisfied;
  return said === 0 ? null : satisfaction.satisfied / said;
}

/** A catalog version as a label: a long hash is cut. */
export function versionLabel(version: string): string {
  return version.length > 12 ? `${version.slice(0, 8)}…` : version;
}

function buildCut(
  placed: readonly Placed[],
  filters: SentimentFilters,
  dimension: Exclude<Dimension, "cause" | "outcome" | "task" | "reason">,
  valueOf: (occurrence: Placed) => { key: string; label: string } | null,
  order: (a: CutValue, b: CutValue) => number,
  always: ReadonlyArray<{ key: string; label: string }> = [],
  max: number = MAX_CUT_VALUES,
): Cut {
  const groups = new Map<string, { label: string; sessions: Set<string>; unresolved: Set<string> }>(
    always.map((value) => [
      value.key,
      { label: value.label, sessions: new Set<string>(), unresolved: new Set<string>() },
    ]),
  );
  for (const occurrence of placed) {
    if (!matches(occurrence, filters, dimension)) continue;
    const value = valueOf(occurrence);
    if (!value) continue;
    const group = groups.get(value.key) ?? {
      label: value.label,
      sessions: new Set<string>(),
      unresolved: new Set<string>(),
    };
    groups.set(value.key, group);
    group.sessions.add(occurrence.turn.sessionId);
    if (occurrence.unresolved) group.unresolved.add(occurrence.turn.sessionId);
  }
  const values = [...groups]
    .map(
      ([key, group]): CutValue => ({
        key,
        label: group.label,
        sessions: group.sessions.size,
        unresolved: group.unresolved.size,
        share: share(group.unresolved.size, group.sessions.size),
        active: filters[dimension] === key,
      }),
    )
    .sort(order);
  const listed = values.slice(0, max);
  const active = values.find((value) => value.active);
  if (active && !listed.includes(active)) listed[listed.length - 1] = active;
  return { values: listed, more: values.length - listed.length };
}

function textState(input: SentimentPageInput): TextState {
  const { textTurns, answered, messages } = input.totals;
  if (messages === 0 && textTurns === 0 && answered === 0) return "no_text";
  if (answered === 0 && !input.modelConfigured) return "model_off";
  return answered < textTurns ? "capped" : "read";
}

export function buildSentimentPage(
  input: SentimentPageInput,
  asked: SentimentQuery,
): SentimentPageModel {
  // Without a costed model call there is nothing to order by cost.
  const query: SentimentQuery =
    asked.sort === "cost" && !input.costKnown ? { ...asked, sort: "impact" } : asked;
  const from = new Date(input.now.getTime() - input.windowDays * DAY_MS);
  const weeks = weeksBetween(from, input.now);
  const outcomeOf = new Map(
    input.sessions.map((session) => [session.sessionId, sessionOutcomeOf(session).outcome]),
  );
  const taskOfTurn = new Map<string, PageTask>();
  for (const task of input.tasks) for (const turnId of task.turnIds) taskOfTurn.set(turnId, task);
  const reasonOf = (task: PageTask | undefined): TaskReason | null =>
    TASK_REASONS.find((known) => known === task?.reason) ?? null;
  const placed: Placed[] = input.turns.flatMap((turn) =>
    occurrencesOf(turn).map((occurrence) => ({
      ...occurrence,
      intent: input.intents.get(turn.turnId) ?? null,
      outcome: outcomeOf.get(turn.sessionId) ?? null,
      task: (() => {
        const task = taskOfTurn.get(turn.turnId);
        return task ? taskFilterOf(task) : null;
      })(),
      reason: reasonOf(taskOfTurn.get(turn.turnId)),
      version: input.versions.get(turn.turnId) ?? null,
      week: weekOf(turn.endedAt),
    })),
  );
  const { filters } = query;
  const filtered = Object.values(filters).some((value) => value !== null);
  const matched = placed.filter((occurrence) => matches(occurrence, filters));

  const affected = new Set(matched.map((occurrence) => occurrence.turn.sessionId));
  const unresolved = new Set(
    matched
      .filter((occurrence) => occurrence.unresolved)
      .map((occurrence) => occurrence.turn.sessionId),
  );
  // The split counts every way sessions ended, so picking one never empties it: it is narrowed by the other filters only.
  const others = Object.entries(filters).some(
    ([dimension, value]) => dimension !== "outcome" && value !== null,
  );
  const affectedByOthers = new Set(
    placed
      .filter((occurrence) => matches(occurrence, filters, "outcome"))
      .map((occurrence) => occurrence.turn.sessionId),
  );
  const splitSessions = others
    ? input.sessions.filter((session) => affectedByOthers.has(session.sessionId))
    : input.sessions;
  // The sessions the page speaks of: under a session outcome, every session that ended that way, with a root cause or not.
  const sessions = filters.outcome
    ? splitSessions.filter((session) => outcomeOf.get(session.sessionId) === filters.outcome)
    : filtered
      ? input.sessions.filter((session) => affected.has(session.sessionId))
      : input.sessions;

  const outcomes = splitSessions.map(sessionOutcomeOf);
  const inSplit = new Set(splitSessions.map((session) => session.sessionId));
  const classes = SESSION_OUTCOMES.map((outcome) => {
    const n = outcomes.filter((read) => read.outcome === outcome).length;
    const answered = input.answers.filter(
      (answer) => inSplit.has(answer.sessionId) && outcomeOf.get(answer.sessionId) === outcome,
    );
    const satisfiedHere = answered.filter((answer) => answer.satisfied).length;
    return {
      outcome,
      sessions: n,
      share: share(n, outcomes.length),
      score: answered.length === 0 ? null : satisfiedHere / answered.length,
      said: answered.length,
    };
  });

  // Asked for thin rows, or for one intent: the rows as they are. Otherwise thin rows of one cause and tool fold.
  // A slice (one intent, one way sessions ended, one task result or reason) shows every row it holds.
  const thinForced =
    filters.intent !== null ||
    filters.outcome !== null ||
    filters.task !== null ||
    filters.reason !== null;
  const fold =
    query.thin || thinForced
      ? { placed: matched, folded: 0 }
      : foldThin(matched, input.minSessions);
  const all = buildRows(fold.placed, weeks, input.minSessions, input.costKnown).sort(
    (a, b) => SORTS[query.sort](a, b) || text(a.key, b.key),
  );
  const thin = all.filter((row) => row.thin);
  const shown = query.thin || thinForced ? all : all.filter((row) => !row.thin);
  const groups = buildGroups(fold.placed, shown, input.costKnown).sort(
    (a, b) => SORTS[query.sort](a, b) || text(a.cause, b.cause),
  );
  const paged = paginate(groups, shown, query.page);
  const top = shown.reduce<RootCauseRow | null>(
    (best, row) => (best === null || SORTS.impact(row, best) < 0 ? row : best),
    null,
  );
  const thinKeys = new Set(thin.map((row) => row.key));
  const keptSessions = new Set(
    fold.placed.filter((o) => !thinKeys.has(exactKey(o))).map((o) => o.turn.sessionId),
  );
  const onlyThin = new Set(
    fold.placed
      .filter((o) => thinKeys.has(exactKey(o)) && !keptSessions.has(o.turn.sessionId))
      .map((o) => o.turn.sessionId),
  );

  const firstSeenOf = new Map<string, number>();
  for (const occurrence of placed) {
    if (occurrence.version === null) continue;
    const at = occurrence.turn.endedAt.getTime();
    firstSeenOf.set(occurrence.version, Math.min(firstSeenOf.get(occurrence.version) ?? at, at));
  }
  const bySessions = (a: CutValue, b: CutValue) =>
    b.sessions - a.sessions ||
    b.unresolved - a.unresolved ||
    text(a.label, b.label) ||
    text(a.key, b.key);

  const state = textState(input);
  const read = state === "capped" || state === "read";
  const satisfaction = read ? countsOf(SATISFACTIONS, input.totals.satisfaction) : null;
  const empty = input.totals.turns === 0 && input.sessions.length === 0;
  const inScope = scopedTasks(input, filters, outcomeOf);
  return {
    projectId: input.projectId,
    windowDays: input.windowDays,
    state: empty ? "empty" : "ready",
    query: { ...query, page: paged.info.page },
    weeks,
    totals: {
      sessions: sessions.length,
      turns: input.totals.turns,
      affected: affected.size,
      unresolved: unresolved.size,
    },
    split: {
      total: outcomes.length,
      classes,
      readBy: readBy(
        outcomes.filter((o) => o.source === "rule").length,
        outcomes.filter((o) => o.source === "model").length,
      ),
    },
    text: {
      state,
      textTurns: input.totals.textTurns,
      answeredTurns: input.totals.answered,
      satisfactionTurns: satisfaction
        ? SATISFACTIONS.reduce((sum, key) => sum + satisfaction[key], 0)
        : 0,
      satisfaction,
      score: scoreOf(satisfaction),
      reactions: read ? countsOf(STORED_REACTIONS, input.totals.reactions) : null,
      inferred: inferredOf(input.totals.replyReactions),
    },
    rows: paged.rows,
    groups: paged.groups,
    pagination: paged.info,
    // Under a session outcome, the intents of sessions that ended that way. Answers read from the agent's replies count too.
    intentScores:
      read || input.answers.length > 0
        ? intentScoresOf(
            filters.outcome
              ? input.answers.filter(
                  (answer) => outcomeOf.get(answer.sessionId) === filters.outcome,
                )
              : input.answers,
            input.intents,
            input.minSessions,
          )
        : null,
    top,
    costKnown: input.costKnown,
    minSessions: input.minSessions,
    hidden: { rows: thin.length, sessions: onlyThin.size, folded: fold.folded },
    thinForced,
    tasks: taskSplitOf(inScope),
    overview: buildOverview({
      tasks: inScope,
      answers: input.answers,
      occurrences: placed,
      filters,
      sort: query.sort,
      costKnown: input.costKnown,
      now: input.now,
      windowDays: input.windowDays,
    }),
    cuts: {
      intent: buildCut(
        placed,
        filters,
        "intent",
        (o) => ({ key: o.intent?.id ?? NO_INTENT, label: o.intent?.label ?? "No intent" }),
        bySessions,
      ),
      tool: buildCut(
        placed,
        filters,
        "tool",
        (o) => (o.tool ? { key: o.tool, label: o.tool } : null),
        bySessions,
      ),
      week: buildCut(
        placed,
        filters,
        "week",
        (o) => ({ key: o.week, label: o.week }),
        (a, b) => text(a.key, b.key),
        weeks.map((week) => ({ key: week, label: week })),
        weeks.length,
      ),
      version: buildCut(
        placed,
        filters,
        "version",
        (o) => (o.version ? { key: o.version, label: versionLabel(o.version) } : null),
        (a, b) =>
          (firstSeenOf.get(a.key) ?? 0) - (firstSeenOf.get(b.key) ?? 0) || text(a.key, b.key),
      ),
    },
    capped: input.capped,
  };
}

/** The page when its rows could not be read. */
export function unavailableSentimentPage(
  projectId: string,
  windowDays: WindowDays,
  query: SentimentQuery,
  minSessions: number,
): SentimentPageModel {
  const none: Cut = { values: [], more: 0 };
  return {
    projectId,
    windowDays,
    state: "unavailable",
    query,
    weeks: [],
    totals: { sessions: 0, turns: 0, affected: 0, unresolved: 0 },
    split: {
      total: 0,
      classes: SESSION_OUTCOMES.map((outcome) => ({
        outcome,
        sessions: 0,
        share: 0,
        score: null,
        said: 0,
      })),
      readBy: "rule",
    },
    text: {
      state: "no_text",
      textTurns: 0,
      answeredTurns: 0,
      satisfactionTurns: 0,
      satisfaction: null,
      score: null,
      reactions: null,
      inferred: null,
    },
    rows: [],
    groups: [],
    pagination: { page: 1, pages: 1, size: PAGE_ROWS, total: 0, from: 0, to: 0 },
    intentScores: null,
    tasks: {
      total: 0,
      classes: TASK_FILTERS.map((filter) => ({ filter, tasks: 0, share: 0 })),
      reasons: [],
      tiers: { t0: 0, t1: 0, tr: 0, t2: 0, t3: 0 },
    },
    overview: emptyOverview(),
    thinForced: false,
    top: null,
    costKnown: false,
    minSessions,
    hidden: { rows: 0, sessions: 0, folded: 0 },
    cuts: { intent: none, tool: none, week: none, version: none },
    capped: false,
  };
}
