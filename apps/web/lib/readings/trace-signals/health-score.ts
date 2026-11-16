import type { SignalKind } from "@/lib/readings/trace-signals/view";

/**
 * The Health score (RC-225): one number from 0 to 100 that says how healthy
 * the agent is, and that every fix moves.
 *
 * It is built from the open issues alone, so every point it is missing names
 * an issue and the way to fix it:
 *
 * - an issue's **reach** is the share of the reading's turns it touches
 *   (`evidence.totalTurns` over the turns read), or its severity when it has
 *   no turns to count (a tool nobody uses, a whole-project rate);
 * - its **harm** is how bad that is for each turn it touches, one of four
 *   levels by kind ({@link ISSUE_HARM}): a turn that breaks costs most, a turn
 *   misled to the wrong tool less, wasted calls or time less again, and what
 *   could only be tidier (unused tools, tools that always run together) least;
 * - issues of one **kind** (one row on the page) combine, and their cost is
 *   capped by their level ({@link HARM_CAP}): twenty chains are one thing to
 *   tidy, not twenty, and waste can only cost so much however widespread.
 *
 * Kinds combine like the chances of a turn getting through untouched:
 * `score = 100 × Π (1 − kind cost)`. Overlapping issues never push it below
 * 0, and what fixing any set of issues wins back is exact: the score without
 * them, minus the score now ({@link gainOf}).
 *
 * The weights are a judgement call, kept here in one table and versioned
 * ({@link HEALTH_SCORE_VERSION}): a change to them is a new version, and the
 * page never compares scores of two versions.
 */

export const HEALTH_SCORE_VERSION = 1;

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
  misleads: "Wrong tool first",
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
  // The agent reaches for the wrong tool first, or corrects itself.
  first_try_miss: "misleads",
  buried_tool: "misleads",
  magnet: "misleads",
  sibling_confusion: "misleads",
  no_follow_through: "misleads",
  tool_switch: "misleads",
  unstable_intent: "misleads",
  self_correcting: "misleads",
  // The turn gets there, spending more calls, tokens or time than it needs.
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

/** The issues of a project's open signal records (`SignalRecord` or `SignalView`-shaped). */
export function scoredIssues(
  records: readonly { id: string; kind: SignalKind; severity: number; totalTurns: number }[],
): ScoredIssue[] {
  return records.map((record) => ({
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

/**
 * Where the missing points go, by level, in whole points that add up to
 * exactly `100 − score`. A product has no unique split, so each kind gets its
 * share of the log of what it keeps (a kind that alone would cost 10 points
 * gets about twice the share of one that would cost 5), rounded so the parts
 * still sum.
 */
export function lostByLevel(
  parts: readonly ScoredPart[],
  value: number,
): Record<IssueHarm, number> {
  const weights: Record<IssueHarm, number> = { breaks: 0, misleads: 0, wastes: 0, tidies: 0 };
  for (const [kind, cost] of kindCosts(parts)) weights[levelOf(kind)] += -Math.log(1 - cost);
  const total = HARM_LEVELS.reduce((sum, level) => sum + weights[level], 0);
  const lost = Math.max(0, 100 - value);
  const out: Record<IssueHarm, number> = { breaks: 0, misleads: 0, wastes: 0, tidies: 0 };
  if (total <= 0 || lost === 0) return out;
  const exact = HARM_LEVELS.map((level) => ({ level, share: (lost * weights[level]) / total }));
  for (const { level, share } of exact) out[level] = Math.floor(share);
  let left = lost - HARM_LEVELS.reduce((sum, level) => sum + out[level], 0);
  for (const { level } of [...exact].sort((a, b) => (b.share % 1) - (a.share % 1))) {
    if (left <= 0) break;
    out[level] += 1;
    left -= 1;
  }
  return out;
}

function partsOf(issues: readonly ScoredIssue[], turnsRead: number): Record<string, ScoredPart> {
  return Object.fromEntries(
    issues.map((issue) => [issue.id, { kind: issue.kind, harm: issueHarm(issue, turnsRead) }]),
  );
}

/** The score, a whole number from 0 to 100. */
export function healthScore(issues: readonly ScoredIssue[], turnsRead: number): number {
  return Math.round(exactScore(Object.values(partsOf(issues, turnsRead))));
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
 * The whole points fixing these issues (by id) together would win back: the
 * score without them, minus the score now. An id the view does not count
 * (a too-early issue) adds nothing.
 */
export function gainOf(
  view: Pick<HealthScoreView, "value" | "parts">,
  ids: readonly string[],
): number {
  const fixed = new Set(ids);
  const rest = Object.entries(view.parts)
    .filter(([id]) => !fixed.has(id))
    .map(([, part]) => part);
  return Math.max(0, Math.round(exactScore(rest)) - view.value);
}

/** The whole points fixing these issues would win back. */
export function scoreGain(
  issues: readonly ScoredIssue[],
  turnsRead: number,
  fixed: ReadonlySet<string>,
): number {
  const parts = partsOf(issues, turnsRead);
  return gainOf({ value: Math.round(exactScore(Object.values(parts))), parts }, [...fixed]);
}

/**
 * The page's score: this reading's, from its open issues, with the change
 * since the previous reading and the trend over the last few. `history` is
 * the stored scores of earlier readings, newest first; any of another version
 * is left out.
 */
export function healthScoreView(
  issues: readonly ScoredIssue[],
  turnsRead: number,
  history: readonly StoredHealthScore[] = [],
): HealthScoreView {
  const parts = partsOf(issues, turnsRead);
  const value = Math.round(exactScore(Object.values(parts)));
  const earlier = history
    .filter((stored) => stored.version === HEALTH_SCORE_VERSION)
    .map((stored) => stored.value);
  const byKind = new Map<SignalKind, string[]>();
  for (const issue of issues) byKind.set(issue.kind, [...(byKind.get(issue.kind) ?? []), issue.id]);
  const kindGains = [...byKind.values()].map((ids) => ({
    ids,
    gain: gainOf({ value, parts }, ids),
  }));
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
    topGain: gainOf({ value, parts }, top),
    lost: lostByLevel(Object.values(parts), value),
    issues: byKind.size,
  };
}
