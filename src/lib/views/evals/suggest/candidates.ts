import type { SuggestionReason } from "../domain/types";

/**
 * RC-616: which low-scoring runs become eval suggestions. A run is a candidate
 * when a scorer's reading of it is under the scorer's good threshold. The
 * candidates rank by how far under they are, then by how recent. A candidate
 * is a near-duplicate of a kept one (or of an existing eval) when the failing
 * scorers and the tool path are the same and the asks are near-identical.
 * Ask similarity is word-set Jaccard, the measure the seed boost uses: no
 * model call and the same answer each time.
 */

/** One reading under its scorer's good threshold. */
export type LowReading = SuggestionReason;

export interface Candidate {
  turnId: string;
  ask: string;
  /** The tools the run called, in order. */
  toolPath: readonly string[];
  endedAt: Date;
  lows: readonly LowReading[];
}

/** An eval already in the set. A null part is unknown and matches anything. */
export interface KnownEval {
  message: string;
  toolPath: readonly string[] | null;
  scorerIds: readonly string[] | null;
}

export interface CandidatePick {
  candidate: Candidate;
  /** The reading furthest under its threshold. */
  reason: LowReading;
}

/** Asks at least this similar are near-identical. */
export const ASK_SIMILARITY_CUTOFF = 0.7;

/** The best candidates, worst score first, with no two near-duplicates and none like an existing eval. */
export function pickCandidates(
  candidates: readonly Candidate[],
  existing: readonly KnownEval[],
  limit: number,
): CandidatePick[] {
  const kept: CandidatePick[] = [];
  const seen: KnownEval[] = [...existing];
  for (const { candidate, reason } of rankCandidates(candidates)) {
    if (kept.length >= limit) break;
    const key: KnownEval = {
      message: candidate.ask,
      toolPath: candidate.toolPath,
      scorerIds: scorerIdsOf(candidate),
    };
    if (seen.some((other) => isNearDuplicate(key, other))) continue;
    kept.push({ candidate, reason });
    seen.push(key);
  }
  return kept;
}

/** Word-set Jaccard of two asks, case, punctuation and ID digits ignored. 1 when both are empty. */
export function askSimilarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}

function rankCandidates(candidates: readonly Candidate[]): CandidatePick[] {
  return candidates
    .filter((candidate) => candidate.lows.length > 0)
    .map((candidate) => ({ candidate, reason: worstOf(candidate.lows) }))
    .sort(
      (a, b) =>
        gapOf(b.reason) - gapOf(a.reason) ||
        b.candidate.endedAt.getTime() - a.candidate.endedAt.getTime() ||
        a.candidate.turnId.localeCompare(b.candidate.turnId),
    );
}

function worstOf(lows: readonly LowReading[]): LowReading {
  return lows.reduce((worst, low) => (gapOf(low) > gapOf(worst) ? low : worst));
}

function gapOf(reading: LowReading): number {
  return reading.threshold - reading.value;
}

function scorerIdsOf(candidate: Candidate): string[] {
  return [...new Set(candidate.lows.map((low) => low.scorerId))].sort();
}

function isNearDuplicate(a: KnownEval, b: KnownEval): boolean {
  if (a.scorerIds && b.scorerIds && !sameList([...a.scorerIds].sort(), [...b.scorerIds].sort()))
    return false;
  if (a.toolPath && b.toolPath && !sameList(a.toolPath, b.toolPath)) return false;
  return askSimilarity(a.message, b.message) >= ASK_SIMILARITY_CUTOFF;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/\d+/g, "0")
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}
