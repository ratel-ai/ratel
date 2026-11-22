import { loadToolCorpus } from "@/lib/ingest/runtime-catalog/inventory";
import { getLogger } from "@/lib/platform/logger";
import type { ExperimentWindow } from "@/lib/synthesis/experiments/service";
import type {
  MatchQualityProposalRow,
  MatchQualityRunRow,
} from "@/lib/synthesis/match-quality/schema";
import {
  byArm,
  type EvaluableSelection,
  observeSelections,
  pickBaselineArm,
  summarizeAnswers,
} from "@/lib/synthesis/quality/ground-truth";
import { scoreObservations } from "@/lib/synthesis/quality/metrics";
import { buildReplayCases } from "./labels";
import { loadLabels, loadReplayHistory } from "./queries";
import { type ReplayResult, replay } from "./replay";
import { loadSourceSelections } from "./search-source";
import { type EngineQuality, type QualityNumbersView, unclearCaveat } from "./view";

/**
 * What the match-quality page computes when it loads, rather than reads off
 * the last run.
 *
 * Two figures used to be frozen into a run and went stale the moment anything
 * changed: each engine's match quality (empty on every run stored before the
 * answer key existed), and "if you apply all N rewrites" (still counting the
 * ones already applied). Both are cheap to compute from what is stored, so the
 * page computes them now:
 *
 *   - the numbers, over the run's window, against today's answer key;
 *   - the projection, replayed against today's catalog (which already carries
 *     every applied rewrite) with ONLY the still-pending rewrites patched in, so
 *     it shrinks toward zero as rewrites are applied one by one.
 *
 * Neither calls a model. A failure costs the page that panel, never the page.
 */

const logger = getLogger("match-quality/live");

/** Each engine's match quality from answer-key targets. Pure. */
export function numbersFromSelections(
  selections: readonly EvaluableSelection[],
  tunedArm: string | null,
  baselineArm: string | null,
): QualityNumbersView | null {
  if (selections.length === 0) return null;
  // One engine (search telemetry): no baseline, and that engine is ours.
  const names = [
    ...new Set(selections.flatMap((selection) => selection.arms.map((arm) => arm.arm))),
  ];
  const baseline = names.length > 1 ? (baselineArm ?? pickBaselineArm(selections)) : null;
  const tuned = tunedArm ?? names.find((arm) => arm !== baseline) ?? null;

  const grouped = byArm(observeSelections(selections, "judged", baseline ?? ""));
  const engine = (arm: string | null): EngineQuality | null => {
    if (arm === null) return null;
    const observations = grouped.get(arm);
    if (!observations || observations.length === 0) return null;
    const score = scoreObservations(observations);
    if (score.containment === null) return null;
    return {
      arm,
      top1: (score.rankHistogram["1"] ?? 0) / score.n,
      containment: score.containment,
      n: score.n,
    };
  };

  const coverage = summarizeAnswers(selections);
  return {
    ours: engine(tuned),
    theirs: engine(baseline),
    coverage,
    caveat: unclearCaveat(coverage.unclear, baseline !== null),
  };
}

/** The live numbers over one window, or null when there is nothing to score. */
export async function loadLiveQuality(
  projectId: string,
  experimentName: string,
  window: ExperimentWindow,
  arms: { tuned: string | null; baseline: string | null },
): Promise<QualityNumbersView | null> {
  try {
    const { selections } = await loadSourceSelections(projectId, experimentName, window);
    return numbersFromSelections(selections, arms.tuned, arms.baseline);
  } catch (err) {
    logger.error({ err, project_id: projectId }, "live match quality failed");
    return null;
  }
}

/**
 * The replay of the rewrites still pending, over today's catalog.
 *
 * `before` is the catalog as it is now, applied rewrites included; `after` adds
 * the pending ones. With none pending it is a standing reading of today.
 */
export async function loadRemainingBacktest(
  projectId: string,
  run: MatchQualityRunRow,
  proposals: readonly MatchQualityProposalRow[],
): Promise<{ result: ReplayResult; pending: number; applied: number } | null> {
  if (!run.tunedArm) return null;
  try {
    const [history, labels, corpus] = await Promise.all([
      loadReplayHistory(projectId),
      loadLabels(projectId),
      loadToolCorpus(projectId),
    ]);
    const cases = buildReplayCases(history, labels, run.tunedArm, run.baselineArm ?? "");
    if (cases.length === 0) return null;
    const pending = proposals.filter((proposal) => proposal.status === "pending");
    const result = replay(
      corpus,
      cases,
      pending.map((proposal) => ({
        entryId: proposal.entryId,
        searchableDescription: proposal.proposedSearchable,
      })),
    );
    return {
      result,
      pending: pending.length,
      applied: proposals.filter((proposal) => proposal.status === "applied").length,
    };
  } catch (err) {
    logger.error({ err, project_id: projectId }, "remaining backtest failed");
    return null;
  }
}
