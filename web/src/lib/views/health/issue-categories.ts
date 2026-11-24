import {
  type OutcomePillar,
  PILLAR_LABEL,
  PILLAR_LEVEL,
} from "@/lib/readings/trace-signals/health-pillars";
import {
  HARM_LABEL,
  HARM_LEVELS,
  type HealthScoreView,
  ISSUE_HARM,
  type IssueHarm,
} from "@/lib/readings/trace-signals/health-score";
import type { IssueRow } from "@/lib/views/health/issue-rows";

/** A measured rate as its category shows it. */
export interface CategoryRate {
  pillar: OutcomePillar;
  label: string;
  /** Share of good outcomes, in [0, 1]. */
  good: number;
  /** Observations behind it. */
  n: number;
}

/** One level of the Health score: what it costs, and why. */
export interface IssueCategory {
  level: IssueHarm;
  label: string;
  /** Whole points the level costs; null when the page shows no score. */
  lost: number | null;
  rates: readonly CategoryRate[];
  /** The issues in the order given (most points first), the ones too early to call after them. */
  rows: readonly IssueRow[];
  /** Rows that count as issues. */
  issues: number;
  /** Rows still too early to call. */
  early: number;
  /** Nothing listed and nothing lost. */
  healthy: boolean;
}

/**
 * The issues and the measured rates under the four levels the Health score counts by, worst
 * first. With a score, the lost points are the score's own, so they add up to `100 − value`.
 */
export function issueCategories(
  rows: readonly IssueRow[],
  score: Pick<HealthScoreView, "lost" | "pillars"> | null,
): IssueCategory[] {
  return HARM_LEVELS.map((level) => {
    const own = rows.filter((row) => ISSUE_HARM[row.kind] === level);
    const early = own.filter((row) => row.tone === "early").length;
    const lost = score ? score.lost[level] : null;
    return {
      level,
      label: HARM_LABEL[level],
      lost,
      rates: (score?.pillars ?? [])
        .filter(({ pillar }) => PILLAR_LEVEL[pillar] === level)
        .map(({ pillar, good, n }) => ({ pillar, label: PILLAR_LABEL[pillar], good, n })),
      rows: own,
      issues: own.length - early,
      early,
      healthy: own.length === 0 && !lost,
    };
  });
}
