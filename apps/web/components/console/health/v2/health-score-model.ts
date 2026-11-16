import {
  HARM_LABEL,
  HARM_LEVELS,
  HEALTH_BAND_LABEL,
  type HealthBand,
  type HealthScoreView,
  type IssueHarm,
} from "@/lib/readings/trace-signals/health-score";

/**
 * The words and shapes around the Health score (RC-225), pure so every case
 * is pinned: the band and its headline, the goal three fixes reach, the
 * change since the last reading, where the missing points go, and the ring's
 * pixels. Plain language, numerals, no formula on the page.
 */

export type ScoreTone = "success" | "warning" | "danger";

export const BAND_TONE: Readonly<Record<HealthBand, ScoreTone>> = {
  healthy: "success",
  good: "success",
  needs_work: "warning",
  struggling: "danger",
};

const HEADLINE: Readonly<Record<HealthBand, string>> = {
  healthy: "Your agent is in great shape.",
  good: "Your agent is doing well.",
  needs_work: "Your agent needs some work.",
  struggling: "Your agent is struggling.",
};

export interface LostPart {
  level: IssueHarm;
  label: string;
  points: number;
}

export interface ScoreCopy {
  band: string;
  tone: ScoreTone;
  headline: string;
  /** "Fix the top 3 issues to reach 92." or what is true when nothing would. */
  goal: string;
  /** The goal's words before its number ("Fix the top 3 issues to reach"); null without a target. */
  goalLead: string | null;
  /** Where three fixes take the score; null when they win nothing. */
  target: number | null;
  /** "+4 since the last reading"; null on the first reading with a score. */
  change: { text: string; direction: "up" | "down" | "flat" } | null;
  /** The levels that cost points, worst first. */
  lost: readonly LostPart[];
  /** How it is counted, in one sentence. */
  basis: string;
}

export function scoreCopy(view: HealthScoreView): ScoreCopy {
  const change =
    view.change === null
      ? null
      : view.change === 0
        ? { text: "No change since the last reading", direction: "flat" as const }
        : {
            text: `${view.change > 0 ? "+" : ""}${view.change} since the last reading`,
            direction: view.change > 0 ? ("up" as const) : ("down" as const),
          };
  const fixing =
    view.issues >= 3
      ? "the top 3 issues"
      : view.issues === 2
        ? "both open issues"
        : "the open issue";
  const target = view.topGain >= 1 ? Math.min(100, view.value + view.topGain) : null;
  const goalLead = target !== null && view.issues > 0 ? `Fix ${fixing} to reach` : null;
  const goal =
    view.issues === 0
      ? "No open issues in this reading."
      : goalLead !== null
        ? `${goalLead} ${target}.`
        : "What is open costs less than a point.";
  const lost = HARM_LEVELS.filter((level) => view.lost[level] > 0).map((level) => ({
    level,
    label: HARM_LABEL[level],
    points: view.lost[level],
  }));
  return {
    band: HEALTH_BAND_LABEL[view.band],
    tone: BAND_TONE[view.band],
    headline: HEADLINE[view.band],
    goal,
    goalLead,
    target,
    change,
    lost,
    basis: "Every open issue costs points by how many turns it touches and how much it hurts them.",
  };
}

/** Pixels around the ring. */
export const RING_CELLS = 36;

/** One pixel of the ring: where it sits and what it shows. */
export interface RingCell {
  x: number;
  y: number;
  /** Degrees, so the pixel follows the arc. */
  angle: number;
  state: "lit" | "tip" | "target" | "off";
}

/**
 * The ring: `RING_CELLS` square pixels on a 270° arc that opens at the
 * bottom, lit clockwise up to the score. The last lit pixel is the tip (what
 * the score is now); the pixels up to `target` show where the next fixes reach.
 */
export function ringCells(
  value: number,
  target: number | null,
  radius = 84,
  center = 100,
): RingCell[] {
  const lit = Math.round((Math.min(100, Math.max(0, value)) / 100) * RING_CELLS);
  const reach =
    target === null ? lit : Math.max(lit, Math.round((Math.min(100, target) / 100) * RING_CELLS));
  return Array.from({ length: RING_CELLS }, (_, index) => {
    const degrees = 135 + (270 * index) / (RING_CELLS - 1);
    const radians = (degrees * Math.PI) / 180;
    const state =
      index < lit - 1 ? "lit" : index === lit - 1 ? "tip" : index < reach ? "target" : "off";
    return {
      x: Math.round((center + radius * Math.cos(radians)) * 100) / 100,
      y: Math.round((center + radius * Math.sin(radians)) * 100) / 100,
      angle: Math.round(degrees + 90),
      state,
    };
  });
}
