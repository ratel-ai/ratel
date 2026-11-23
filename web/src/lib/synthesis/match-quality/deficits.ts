import { rankOf } from "@/lib/synthesis/quality/ground-truth";
import type { Candidate, CandidateFailure, EvalItem } from "./types";

/**
 * Which catalog entries are worth asking a model about, and why.
 *
 * Pure: it reads the frozen evaluation set and nothing else, so the same run
 * re-scored later produces the same candidates.
 *
 * A FAILURE IS A TARGET OUTSIDE THE LIST THE AGENT SAW. Each arm's recorded
 * list is its own top-k, so a target at #2 or #4 was in front of the agent and
 * the search worked. Those are counted as `buried`, for context, and nominate
 * nothing: rewriting a description that is already being shown, to move it one
 * slot, is how a working neighbour gets broken. Only a target we did not return
 * at all loses credit here, and it loses the whole point, the same zero
 * `lib/quality/metrics.ts:hitCredit` gives it on the meter.
 *
 * Only entries that were the TARGET of a search can be nominated. An entry that
 * merely shows up a lot in our lists is noise, not a coverage problem, and
 * rewriting its description to make it show up less is how you break a tool that
 * was working. Distractions are counted and handed to the model as context, never
 * as a reason on their own.
 */

/**
 * How many entries one run asks about.
 *
 * The cap is what keeps a single model call affordable on a 93-entry catalog, and
 * it is also a product decision: a worklist longer than this is one nobody works
 * through, so a run that proposed everything would be ignored exactly as
 * thoroughly as one that proposed nothing.
 */
export const MAX_CANDIDATES = 12;

/**
 * How many worked failures travel with each candidate into the prompt.
 *
 * Deduplicated by query first, so forty repetitions of one phrasing spend one
 * slot rather than all of them.
 */
export const MAX_FAILURES_PER_CANDIDATE = 8;

interface Tally {
  entryId: string;
  misses: number;
  buried: number;
  targeted: number;
  distractions: number;
  loss: number;
  failures: CandidateFailure[];
  seenQueries: Set<string>;
}

function tallyFor(byEntry: Map<string, Tally>, entryId: string): Tally {
  const existing = byEntry.get(entryId);
  if (existing) return existing;
  const fresh: Tally = {
    entryId,
    misses: 0,
    buried: 0,
    targeted: 0,
    distractions: 0,
    loss: 0,
    failures: [],
    seenQueries: new Set(),
  };
  byEntry.set(entryId, fresh);
  return fresh;
}

/**
 * Rank every entry by how much retrieval credit it lost, worst first.
 *
 * `ourArm` is the arm being tuned; `baselineArm` supplies the comparison shown in
 * each failure. A selection where `ourArm` did not run at all is skipped rather
 * than scored as a miss: it is missing data, not a bad answer.
 */
export function pickCandidates(
  items: readonly EvalItem[],
  ourArm: string,
  baselineArm: string,
  opts: { cap?: number; nameById?: ReadonlyMap<string, string> } = {},
): Candidate[] {
  const cap = opts.cap ?? MAX_CANDIDATES;
  const byEntry = new Map<string, Tally>();

  for (const item of items) {
    const ours = item.arms.find((arm) => arm.arm === ourArm);
    if (!ours) continue;
    const baseline = item.arms.find((arm) => arm.arm === baselineArm);

    const rank = rankOf(ours.resultIds, item.targetEntryId);
    const target = tallyFor(byEntry, item.targetEntryId);
    target.targeted += 1;

    if (rank === 1) continue;

    // Everything we returned INSTEAD of the target was, on this search, a
    // distractor. Recorded for context; it never nominates on its own.
    for (const returned of ours.resultIds) {
      if (returned === item.targetEntryId) continue;
      tallyFor(byEntry, returned).distractions += 1;
    }

    // Anywhere else in the list the agent saw is still a success. First place
    // is better, but a lower slot is not a failure, so it costs nothing and
    // nominates nothing. It is counted, so the prompt can say how often we were
    // shown below first.
    if (rank !== null) {
      target.buried += 1;
      continue;
    }

    target.loss += 1;
    target.misses += 1;

    const queryKey = item.query?.trim() ?? "";
    if (target.failures.length < MAX_FAILURES_PER_CANDIDATE && !target.seenQueries.has(queryKey)) {
      target.seenQueries.add(queryKey);
      target.failures.push({
        selectionId: item.selectionId,
        query: item.query,
        ourRank: rank,
        ourTop: ours.resultIds[0] ?? null,
        baselineTop: baseline?.resultIds[0] ?? null,
        targetSource: item.targetSource,
      });
    }
  }

  return [...byEntry.values()]
    .filter((tally) => tally.loss > 0)
    .sort((left, right) => right.loss - left.loss || compare(left.entryId, right.entryId))
    .slice(0, cap)
    .map(({ seenQueries: _seen, ...candidate }) => ({
      ...candidate,
      // Falls back to the id when the corpus has no row for it, which happens for
      // an entry telemetry saw but the catalog never ingested.
      name: opts.nameById?.get(candidate.entryId) ?? candidate.entryId,
    }));
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
