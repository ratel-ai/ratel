import type { GroundTruthLabel } from "./labels";
import { buildReplayCases } from "./labels";
import { REPLAY_CREDIT, type ReplayResult, replay } from "./replay";
import type { CorpusEntry, EvalItem } from "./types";

/**
 * Re-scoring stored backtests after the credit curve changes.
 *
 * A run's backtest is computed once, when the run finishes, and stored. So when
 * `metrics.ts:hitCredit` changes shape, every stored result keeps the old
 * numbers until the next weekly run, and the page prints old and new side by
 * side as if they were the same scale. This recomputes them in place.
 *
 * NO MODEL CALLS. Everything a replay needs is already stored: the frozen
 * evaluation items, the answer key, the proposal text and today's corpus. That
 * is the whole reason this can run unattended in the drain.
 *
 * WHAT "THE SAME BACKTEST" MEANS NOW. The replay was always run against the
 * corpus as it stood when the run finished. Two things have moved since, and
 * they are handled differently on purpose:
 *
 *   - A proposal from this run that was APPLIED is now in the corpus. Replaying
 *     it against a corpus that already contains it would measure a delta of
 *     zero, so its entry is put back to the text the proposal was drafted
 *     against. That reconstructs the "before" the run actually measured.
 *   - Everything else, other edits and the history accumulated since, is taken
 *     as it is today. That is the same drift any fresh run would see, and it is
 *     what makes the re-scored number answer the panel's question now: if I
 *     apply these, does the catalog get better?
 */

/** A stored result that was scored with a different curve, or none recorded. */
export function isStaleBacktest(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  return (raw as Record<string, unknown>).credit !== REPLAY_CREDIT;
}

/** One stored proposal, as much of it as a replay needs. */
export interface RescoreProposal {
  id: string;
  entryId: string;
  status: string;
  currentSearchable: string;
  proposedSearchable: string;
  backtest: unknown;
}

export interface RescoreInput {
  corpus: readonly CorpusEntry[];
  history: readonly EvalItem[];
  labels: ReadonlyMap<string, GroundTruthLabel>;
  tunedArm: string;
  baselineArm: string;
  /** The run's stored portfolio result. Null when the run never had one. */
  runBacktest: unknown;
  /** Every proposal the run created, whatever became of it since. */
  proposals: readonly RescoreProposal[];
}

export interface RescoreOutput {
  /** The run's new portfolio result, or null to leave the run untouched. */
  runBacktest: (ReplayResult & { discarded?: number }) | null;
  /**
   * New per-proposal results, keyed by proposal id. Only stale ones appear. A
   * null clears a result that can no longer be reproduced on the current curve.
   */
  proposalBacktests: Map<string, ReplayResult | null>;
}

/** Recompute a run's stored backtests on the current curve. Pure. */
export function rescoreRun(input: RescoreInput): RescoreOutput {
  const cases = buildReplayCases(input.history, input.labels, input.tunedArm, input.baselineArm);
  const proposalBacktests = new Map<string, ReplayResult | null>();
  if (cases.length === 0) {
    // Nothing left to replay. Old numbers are cleared rather than kept, because
    // they would be the only figures on the page on a different scale.
    for (const proposal of input.proposals) {
      if (isStaleBacktest(proposal.backtest)) proposalBacktests.set(proposal.id, null);
    }
    return { runBacktest: null, proposalBacktests };
  }

  const corpus = corpusAtRun(input.corpus, input.proposals);

  for (const proposal of input.proposals) {
    if (!isStaleBacktest(proposal.backtest)) continue;
    proposalBacktests.set(
      proposal.id,
      replay(corpus, cases, [
        { entryId: proposal.entryId, searchableDescription: proposal.proposedSearchable },
      ]),
    );
  }

  let runBacktest: RescoreOutput["runBacktest"] = null;
  if (isStaleBacktest(input.runBacktest)) {
    // The set the run OFFERED, which is every proposal it stored: the discarded
    // drafts were never written, so nothing here can reintroduce them.
    const portfolio = replay(
      corpus,
      cases,
      input.proposals.map((proposal) => ({
        entryId: proposal.entryId,
        searchableDescription: proposal.proposedSearchable,
      })),
    );
    const discarded = (input.runBacktest as Record<string, unknown>).discarded;
    runBacktest = typeof discarded === "number" ? { ...portfolio, discarded } : portfolio;
  }

  return { runBacktest, proposalBacktests };
}

/**
 * Today's corpus with this run's applied rewrites taken back out.
 *
 * See the module comment. Only `applied`: a reverted proposal's entry is
 * already back to its old text, and the other statuses never touched the
 * catalog.
 */
export function corpusAtRun(
  corpus: readonly CorpusEntry[],
  proposals: readonly RescoreProposal[],
): CorpusEntry[] {
  const before = new Map(
    proposals
      .filter((proposal) => proposal.status === "applied")
      .map((proposal) => [proposal.entryId, proposal.currentSearchable]),
  );
  if (before.size === 0) return [...corpus];
  return corpus.map((entry) => {
    const searchable = before.get(entry.entryId);
    return searchable === undefined ? entry : { ...entry, searchable };
  });
}
