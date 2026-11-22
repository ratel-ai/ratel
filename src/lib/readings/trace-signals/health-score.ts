import {
  outcomeLost,
  outcomeScore,
  PILLAR_LEVEL,
  type PillarReading,
} from "@/lib/readings/trace-signals/health-pillars";
import { existingToolStanding } from "@/lib/readings/trace-signals/signals/unknown-tool-standing";
import type { SignalKind } from "@/lib/readings/trace-signals/view";

/**
 * The Health score (RC-225, v2 in RC-226): one number from 0 to 100 that says
 * how healthy the agent is, and that every fix moves.
 *
 * Two halves, blended ({@link OUTCOME_SHARE}):
 *
 * - **how the runs went** (`health-outcomes.ts`): measured rates over the
 *   reading's window (runs end well, right tool first, no self-corrections,
 *   tasks finish, calls work). It moves as soon as the agent behaves better;
 * - **what is still open**: every open issue, weighed so each lost point names
 *   an issue and the way to fix it:
 *   - an issue's **reach** is the share of the reading's turns it touches
 *     (`evidence.totalTurns` over the turns read), or its severity when it has
 *     no turns to count (a tool nobody uses, a whole-project rate);
 *   - its **harm** is how bad that is for each turn it touches, one of four
 *     levels by kind ({@link ISSUE_HARM}): a turn that breaks costs most, a
 *     turn misled to the wrong tool less, wasted calls or time less again,
 *     and what could only be tidier (unused tools, chains) least;
 *   - issues of one **kind** (one row on the page) combine, and their cost is
 *     capped by their level ({@link HARM_CAP});
 *   - kinds combine like the chances of a turn getting through untouched:
 *     `100 × Π (1 − kind cost)`, never below 0.
 *
 * What fixing issues wins back is exact for the issue half ({@link gainOf});
 * the measured half follows at the next reading, once the runs show the fix.
 *
 * The weights are a judgement call, kept in one table each and versioned
 * ({@link HEALTH_SCORE_VERSION}): a change to them is a new version, and the
 * page never compares scores of two versions.
 */

export const HEALTH_SCORE_VERSION = 2;

export type IssueHarm = "breaks" | "misleads" | "wastes" | "tidies";

/** How much of a touched turn each level of harm takes away. */
export const HARM_WEIGHT: Readonly<Record<IssueHarm, number>> = {
  breaks: 1,
  misleads: 0.6,
  wastes: 0.25,
  tidies: 0.1,
};

/** The most (as a share of 100) the issues of one kind can cost, by level. */
export const HARM_CAP: Readonly<Record<IssueHarm, number>> = {
  breaks: 0.3,
  misleads: 0.2,
  wastes: 0.1,
  tidies: 0.05,
};

/** The levels as the page names them, worst first. */
export const HARM_LEVELS: readonly IssueHarm[] = ["breaks", "misleads", "wastes", "tidies"];

export const HARM_LABEL: Readonly<Record<IssueHarm, string>> = {
  breaks: "Failing turns",
  misleads: "Detours and corrections",
  wastes: "Wasted calls and time",
  tidies: "Tidying",
};

/** What each kind of issue does to the turns it touches. */
export const ISSUE_HARM: Readonly<Record<SignalKind, IssueHarm>> = {
  // The turn fails, or ends without doing what was asked.
  error_loop: "breaks",
  identical_retry: "breaks",
  unknown_tool: "breaks",
  blocked_action: "breaks",
  empty_result: "breaks",
  abandoned_search: "breaks",
  system_turn_failing: "breaks",
  agent_failing: "breaks",
  workflow_failing: "breaks",
  // The agent cannot find the right tool where it reads, or goes the wrong way and corrects itself.
  buried_tool: "misleads",
  sibling_confusion: "misleads",
  tool_switch: "misleads",
  unstable_intent: "misleads",
  self_correcting: "misleads",
  // The turn gets there, spending more calls, tokens or time than it needs.
  // Taking another tool first, or searching twice, is a wasted call, not a
  // wrong turn: with the right tool in the top 5 the agent finds it (RC-226).
  first_try_miss: "wastes",
  magnet: "wastes",
  no_follow_through: "wastes",
  padding_share: "wastes",
  repeat_invoke: "wastes",
  latency_outlier: "wastes",
  long_turn: "wastes",
  wait_heavy: "wastes",
  token_heavy: "wastes",
  workflow_slow: "wastes",
  // Nothing goes wrong in a turn; the catalog or the asks could be simpler.
  sequence_chain: "tidies",
  workflow_fixed_chain: "tidies",
  dead_tool: "tidies",
  unused_tool: "tidies",
  fragmented_intents: "tidies",
  cooccurring_intents: "tidies",
};

/**
 * The issues of a project's open signal records (`SignalRecord` or `SignalView`-shaped).
 * An `unknown_tool` whose calls ran is a gap in the captured tool list, not a
 * failing turn, so it costs no points. One only the catalog vouches for has no
 * ok call, so its turns still count.
 */
export function scoredIssues(
  records: readonly {
    id: string;
    kind: SignalKind;
    severity: number;
    totalTurns: number;
    metrics?: Readonly<Record<string, unknown>>;
  }[],
): ScoredIssue[] {
  return records
    .filter(
      (record) =>
        !(
          record.kind === "unknown_tool" &&
          record.metrics &&
          existingToolStanding(record.metrics) === "succeeded"
        ),
    )
    .map((record) => ({
      id: record.id,
      kind: record.kind,
      severity: record.severity,
      turns: record.totalTurns,
    }));
}

/** What the score reads of one open issue. */
export interface ScoredIssue {
  id: string;
  kind: SignalKind;
  /** The Wilson bound the detector fired on, in [0, 1]. */
  severity: number;
  /** Turns behind it in the reading; 0 when it has none to count. */
  turns: number;
}

export type HealthBand = "healthy" | "good" | "needs_work" | "struggling";

export const HEALTH_BAND_LABEL: Readonly<Record<HealthBand, string>> = {
  healthy: "Healthy",
  good: "Good",
  needs_work: "Needs work",
  struggling: "Struggling",
};

export function healthBand(score: number): HealthBand {
  if (score >= 90) return "healthy";
  if (score >= 75) return "good";
  if (score >= 50) return "needs_work";
  return "struggling";
}

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

function levelOf(kind: SignalKind): IssueHarm {
  return ISSUE_HARM[kind] ?? "wastes";
}

/** One issue's harm before its kind's cap: its reach times its level's weight. */
export function issueHarm(issue: ScoredIssue, turnsRead: number): number {
  const reach =
    issue.turns > 0 && turnsRead > 0
      ? Math.min(1, issue.turns / turnsRead)
      : clamp01(issue.severity);
  return reach * HARM_WEIGHT[levelOf(issue.kind)];
}

/** An issue as the score keeps it: its kind and its harm. */
export interface ScoredPart {
  kind: SignalKind;
  harm: number;
}

/** Each kind's capped cost, in [0, its level's cap]. */
function kindCosts(parts: readonly ScoredPart[]): Map<SignalKind, number> {
  const through = new Map<SignalKind, number>();
  for (const part of parts) through.set(part.kind, (through.get(part.kind) ?? 1) * (1 - part.harm));
  return new Map(
    [...through].map(([kind, kept]) => [kind, Math.min(HARM_CAP[levelOf(kind)], 1 - kept)]),
  );
}

/** The exact score, before rounding, of a set of parts. */
function exactScore(parts: readonly ScoredPart[]): number {
  let score = 100;
  for (const cost of kindCosts(parts).values()) score *= 1 - cost;
  return score;
}

/** The issue half's missing points by level, exact: each kind's share of the log of what it keeps. */
function issueLostByLevel(parts: readonly ScoredPart[], lost: number): Record<IssueHarm, number> {
  const weights: Record<IssueHarm, number> = { breaks: 0, misleads: 0, wastes: 0, tidies: 0 };
  for (const [kind, cost] of kindCosts(parts)) weights[levelOf(kind)] += -Math.log(1 - cost);
  const total = HARM_LEVELS.reduce((sum, level) => sum + weights[level], 0);
  const out: Record<IssueHarm, number> = { breaks: 0, misleads: 0, wastes: 0, tidies: 0 };
  if (total <= 0) return out;
  for (const level of HARM_LEVELS) out[level] = (lost * weights[level]) / total;
  return out;
}

/** Exact shares rounded to whole points that still add up to `total` (largest remainder). */
function wholePoints(exact: Record<IssueHarm, number>, total: number): Record<IssueHarm, number> {
  const out: Record<IssueHarm, number> = { breaks: 0, misleads: 0, wastes: 0, tidies: 0 };
  const sum = HARM_LEVELS.reduce((acc, level) => acc + exact[level], 0);
  if (total <= 0 || sum <= 0) return out;
  const scaled = HARM_LEVELS.map((level) => ({ level, share: (total * exact[level]) / sum }));
  for (const { level, share } of scaled) out[level] = Math.floor(share);
  let left = total - HARM_LEVELS.reduce((acc, level) => acc + out[level], 0);
  for (const { level } of [...scaled].sort((a, b) => (b.share % 1) - (a.share % 1))) {
    if (left <= 0) break;
    out[level] += 1;
    left -= 1;
  }
  return out;
}

/**
 * Where the missing points go, by level, in whole points that add up to
 * exactly `100 − score`. A product has no unique split, so each kind gets its
 * share of the log of what it keeps (a kind that alone would cost 10 points
 * gets about twice the share of one that would cost 5); each measured rate
 * adds its own missing points to its level (`PILLAR_LEVEL`).
 */
export function lostByLevel(
  parts: readonly ScoredPart[],
  value: number,
  pillars: readonly PillarReading[] = [],
): Record<IssueHarm, number> {
  const outcome = outcomeScore(pillars);
  const issueShare = outcome === null ? 1 : 1 - OUTCOME_SHARE;
  const exact = issueLostByLevel(parts, 100 - exactScore(parts));
  const combined: Record<IssueHarm, number> = { breaks: 0, misleads: 0, wastes: 0, tidies: 0 };
  for (const level of HARM_LEVELS) combined[level] = exact[level] * issueShare;
  if (outcome !== null) {
    for (const [pillar, lost] of outcomeLost(pillars))
      combined[PILLAR_LEVEL[pillar]] += lost * OUTCOME_SHARE;
  }
  return wholePoints(combined, Math.max(0, 100 - value));
}

function partsOf(issues: readonly ScoredIssue[], turnsRead: number): Record<string, ScoredPart> {
  return Object.fromEntries(
    issues.map((issue) => [issue.id, { kind: issue.kind, harm: issueHarm(issue, turnsRead) }]),
  );
}

/**
 * The measured half's share of the score (RC-226): how the runs went counts
 * for this much, the open issues for the rest. Without a measured rate that
 * has enough evidence, the issues are the whole score.
 */
export const OUTCOME_SHARE = 0.6;

/** The score before rounding: the measured half and the issue half, blended. */
function blend(issueExact: number, outcome: number | null): number {
  return outcome === null ? issueExact : OUTCOME_SHARE * outcome + (1 - OUTCOME_SHARE) * issueExact;
}

/** The score, a whole number from 0 to 100. */
export function healthScore(
  issues: readonly ScoredIssue[],
  turnsRead: number,
  pillars: readonly PillarReading[] = [],
): number {
  return Math.round(
    blend(exactScore(Object.values(partsOf(issues, turnsRead))), outcomeScore(pillars)),
  );
}

/** A score as a reading stores it (`summary.healthScore`). */
export interface StoredHealthScore {
  version: number;
  value: number;
}

export function parseStoredHealthScore(raw: unknown): StoredHealthScore | null {
  if (!raw || typeof raw !== "object") return null;
  const { version, value } = raw as { version?: unknown; value?: unknown };
  if (typeof version !== "number" || typeof value !== "number" || !Number.isFinite(value))
    return null;
  return { version, value };
}

/** What the page shows. */
export interface HealthScoreView {
  value: number;
  band: HealthBand;
  /** Points since the previous reading with a score of this version; null without one. */
  change: number | null;
  /** The readings' scores, oldest first, ending with this one (at most {@link SCORE_TREND_READINGS}). */
  trend: readonly number[];
  /** Each open issue (by id) as the score counts it, so any gain is worked out from the view (`gainOf`). */
  parts: Readonly<Record<string, ScoredPart>>;
  /** The measured half, 0 to 100 and exact; null when no rate had enough evidence. */
  outcome: number | null;
  /** The measured rates behind it, in pillar order. */
  pillars: readonly PillarReading[];
  /** The issue half on its own, 0 to 100. */
  issueScore: number;
  /** Points fixing the three costliest kinds of issue would win back together. */
  topGain: number;
  /** Where the missing points go, by level; they add up to `100 − value`. */
  lost: Readonly<Record<IssueHarm, number>>;
  /** Kinds of open issue behind the score (about one row each on the page). */
  issues: number;
}

/** Readings the trend shows. */
export const SCORE_TREND_READINGS = 8;

/**
 * The whole points fixing these issues (by id) together would win back now:
 * the score without them, minus the score now. Only the issue half moves;
 * the measured half follows at the next reading, when the runs show the fix.
 * An id the view does not count (a too-early issue) adds nothing.
 */
export function gainOf(
  view: Pick<HealthScoreView, "value" | "parts" | "outcome">,
  ids: readonly string[],
): number {
  const fixed = new Set(ids);
  const rest = Object.entries(view.parts)
    .filter(([id]) => !fixed.has(id))
    .map(([, part]) => part);
  return Math.max(0, Math.round(blend(exactScore(rest), view.outcome)) - view.value);
}

/** The whole points fixing these issues would win back. */
export function scoreGain(
  issues: readonly ScoredIssue[],
  turnsRead: number,
  fixed: ReadonlySet<string>,
  pillars: readonly PillarReading[] = [],
): number {
  const parts = partsOf(issues, turnsRead);
  const outcome = outcomeScore(pillars);
  return gainOf(
    { value: Math.round(blend(exactScore(Object.values(parts)), outcome)), parts, outcome },
    [...fixed],
  );
}

/**
 * The page's score: this reading's, from its open issues and its measured
 * rates, with the change since the previous reading and the trend over the
 * last few. `history` is the stored scores of earlier readings, newest
 * first; any of another version is left out.
 */
export function healthScoreView(
  issues: readonly ScoredIssue[],
  turnsRead: number,
  history: readonly StoredHealthScore[] = [],
  pillars: readonly PillarReading[] = [],
): HealthScoreView {
  const parts = partsOf(issues, turnsRead);
  const issueExact = exactScore(Object.values(parts));
  const outcome = outcomeScore(pillars);
  const value = Math.round(blend(issueExact, outcome));
  const earlier = history
    .filter((stored) => stored.version === HEALTH_SCORE_VERSION)
    .map((stored) => stored.value);
  const byKind = new Map<SignalKind, string[]>();
  for (const issue of issues) byKind.set(issue.kind, [...(byKind.get(issue.kind) ?? []), issue.id]);
  const scored = { value, parts, outcome };
  const kindGains = [...byKind.values()].map((ids) => ({ ids, gain: gainOf(scored, ids) }));
  const top = kindGains
    .sort((a, b) => b.gain - a.gain)
    .slice(0, 3)
    .flatMap((kind) => kind.ids);
  return {
    value,
    band: healthBand(value),
    change: earlier.length > 0 ? value - earlier[0]! : null,
    trend: [...earlier.slice(0, SCORE_TREND_READINGS - 1).reverse(), value],
    parts,
    outcome,
    pillars: [...pillars],
    issueScore: Math.round(issueExact),
    topGain: gainOf(scored, top),
    lost: lostByLevel(Object.values(parts), value, pillars),
    issues: byKind.size,
  };
}
