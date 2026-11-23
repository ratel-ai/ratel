import { scoreRun } from "@/lib/views/task-scorers/engine";
import { costLimit, latencyLimit } from "@/lib/views/task-scorers/outcome";
import type { Scorer, ScorerResult, ScorerRun } from "@/lib/views/task-scorers/types";

/**
 * RC-76: the scoring rules of a model replay, shared by the eval gate and task
 * simulations. Live runs have no replay, so live scoring does not use them and
 * `SCORER_VERSION` does not change with them. Pure.
 */

/** What a replay side says about the run's work. Absent on live runs and on sides where it isn't read. */
export interface ReplayWork {
  /** A merge's replay side made every recorded call, with the merged tool in place of its sources. */
  coversRecording?: boolean | null;
  /** A merged call asked for what the run never did, so only a stand-in answered it. */
  workUnverified?: boolean;
}

/** "Does the run's work": null when not read; a side that stops short or that only a stand-in answered fails. */
export function doesTheWork(side: ReplayWork): { pass: boolean; detail: string } | null {
  if (typeof side.coversRecording !== "boolean") return null;
  if (side.coversRecording) return { pass: true, detail: "makes every call the run made" };
  return {
    pass: false,
    detail: side.workUnverified
      ? "asks the merged tool for what the run never did; the replay can't vouch it worked"
      : "stops short of what the run did",
  };
}

/**
 * The per-scorer results of one replay side, under the rule the verdict reads
 * (`doesTheWork`, `sideScore`): a side short of the run's work fails every
 * measured scorer with score 0, so a per-scorer column can't pass where the
 * verdict fails. A scorer that wasn't measured stays a skip. Without coverage
 * (live runs, non-merge fixes) this is `scoreRun`.
 */
export function scoreReplaySide(
  side: ScorerRun & ReplayWork,
  scorers: readonly Scorer[],
): ScorerResult[] {
  const results = scoreRun(side, scorers);
  const work = doesTheWork(side);
  if (work?.pass !== false) return results;
  return results.map((result) =>
    result.status === "skip"
      ? result
      : { ...result, status: "fail", score: 0, detail: `${result.detail}; ${work.detail}` },
  );
}

/**
 * A side's mean over its measured scores. A side short of the run's work
 * scores 0 whatever its other checks read: fewer calls, less cost and a quick
 * answer are no credit when the work wasn't done.
 */
export function sideScore(scores: readonly number[], work: { pass: boolean } | null): number {
  if (scores.length === 0 || work?.pass === false) return 0;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

/**
 * Cost and time limits read against the replay's own baseline (the side
 * without the fix), with the room and rounding of drafted limits. A replay
 * prices real tokens and takes real model time, so a limit drafted from a
 * recording fails even the baseline.
 */
export function replayLimits(baseline: Pick<ScorerRun, "costUsd" | "latencyMs">): {
  maxCostUsd: number | null;
  maxLatencyMs: number | null;
} {
  return {
    maxCostUsd: costLimit(baseline.costUsd),
    maxLatencyMs: latencyLimit(baseline.latencyMs),
  };
}

/** Drafted cost and time scorers rebased on the replay's baseline. A limit a person set stays as set. */
export function rebaseScorers(
  scorers: readonly Scorer[],
  baseline: Pick<ScorerRun, "costUsd" | "latencyMs">,
  drafted: (scorer: Scorer) => boolean,
): Scorer[] {
  const limits = replayLimits(baseline);
  return scorers.map((scorer) => {
    if (!drafted(scorer)) return scorer;
    if (scorer.kind === "max_cost_usd" && limits.maxCostUsd !== null)
      return { ...scorer, max: limits.maxCostUsd };
    if (scorer.kind === "max_latency_ms" && limits.maxLatencyMs !== null)
      return { ...scorer, max: limits.maxLatencyMs };
    return scorer;
  });
}
