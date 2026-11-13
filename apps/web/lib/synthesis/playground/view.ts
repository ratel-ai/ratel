import type { RankingChange, RankingDiffEntry } from "@/lib/synthesis/experiments/ranking";
import type { RankedHit, RankMode } from "./types";

/**
 * Presentation helpers for the Playground. Pure, so the labels the UI shows are
 * unit-testable and the score formatting cannot drift between the two ranking
 * columns that sit next to each other.
 */

export type ChangeTone = "stable" | "moved" | "dropped" | "added";

/**
 * BM25 scores are unbounded and corpus-relative, while blended scores live in
 * [0, 1]. Both are shown to three decimals with no percent sign: a percentage
 * would imply a ceiling that lexical scores do not have.
 */
export function formatRankScore(score: number): string {
  if (!Number.isFinite(score)) return "—";
  return score.toFixed(3);
}

/** Rank movement between the two columns, from the drafted side's point of view. */
export function movementLabel(entry: RankingDiffEntry | undefined): string | null {
  if (!entry) return null;
  switch (entry.change) {
    case "added":
      return "new";
    case "dropped":
      return "dropped";
    case "stable":
      return null;
    case "moved": {
      if (entry.servedRank === null || entry.shadowRank === null) return null;
      const delta = entry.servedRank - entry.shadowRank;
      return delta > 0 ? `▲${delta}` : `▼${Math.abs(delta)}`;
    }
  }
}

/** Whether a movement is an improvement, a regression, or neither. */
export function movementTone(entry: RankingDiffEntry | undefined): "up" | "down" | "neutral" {
  if (!entry) return "neutral";
  if (entry.change === "added") return "up";
  if (entry.change === "dropped") return "down";
  if (entry.change !== "moved") return "neutral";
  if (entry.servedRank === null || entry.shadowRank === null) return "neutral";
  return entry.servedRank > entry.shadowRank ? "up" : "down";
}

/** Index a bucket's diff entries by capability id for row-level lookup. */
export function diffByIndexedId(
  entries: readonly RankingDiffEntry[],
): Map<string, RankingDiffEntry> {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

/** Ids the edit pushed out of the top-K entirely: the easiest regression to miss. */
export function droppedIds(entries: readonly RankingDiffEntry[]): string[] {
  return entries.filter((entry) => entry.change === "dropped").map((entry) => entry.id);
}

const MODE_LABEL: Record<RankMode, string> = {
  bm25: "BM25",
  embeddings: "Embeddings",
  hybrid: "Hybrid",
};

export function modeLabel(mode: RankMode): string {
  return MODE_LABEL[mode];
}

/**
 * What a mode does, short enough to live in a tooltip.
 *
 * Deliberately not a standing paragraph: a sentence that is always on screen is
 * read once and then becomes furniture, while the reader still has to work out
 * which control it describes. On hover it answers the question at the moment it
 * is asked.
 */
export function modeHint(mode: RankMode): string {
  switch (mode) {
    case "bm25":
      return "Matches words. The index the agent really uses, so a capability that shares no word with the prompt cannot be found at all.";
    case "embeddings":
      return "Matches meaning. Everything gets a score, so the last result is the least related rather than a non-match.";
    case "hybrid":
      return "Both, mixed by the slider beside it.";
  }
}

/** Whether a bucket's result set is worth calling out as empty, and why. */
export function emptyBucketReason(
  hits: readonly RankedHit[],
  populationSize: number,
  mode: RankMode,
): string | null {
  if (hits.length > 0) return null;
  if (populationSize === 0) return "Nothing in this catalog yet.";
  return mode === "bm25"
    ? "Nothing here shares a word with the prompt."
    : "Nothing here could be scored for this prompt.";
}

export const CHANGE_ORDER: RankingChange[] = ["moved", "added", "dropped", "stable"];

/**
 * Cells to light in a blocky meter for a normalized share.
 *
 * A count rather than a percentage width, because the meter is drawn as
 * discrete squares: it reads as a quantity you can literally count, and it
 * cannot render a one-pixel sliver that looks like nothing at all.
 *
 * Anything above zero lights at least one cell. A capability that scored is not
 * the same as one that did not, and rounding it down to an empty meter would
 * say it was.
 */
export function meterCells(fill: number, cells: number): number {
  if (!Number.isFinite(fill) || fill <= 0) return 0;
  const clamped = Math.min(1, fill);
  return Math.max(1, Math.min(cells, Math.round(clamped * cells)));
}

/** A normalized share as a whole percentage, for the peek's caption. */
export function sharePercent(fill: number): number {
  if (!Number.isFinite(fill) || fill <= 0) return 0;
  return Math.round(Math.min(1, fill) * 100);
}
