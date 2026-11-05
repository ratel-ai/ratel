import type { CaseResult, ReplayStop } from "./types";

/**
 * RC-76: what a replay did, next to what the run did, as the eval pages show
 * it ("What the replay did"). Pure.
 */

/** One run's tool paths (tool ids, in order): recorded, and each side of its replay. */
export interface ReplayPathsView {
  recorded: string[];
  /** Without the fix. */
  before: string[];
  /** With the fix; null when that side wasn't replayed (no baseline). */
  after: string[] | null;
  /** A merge's recorded path with the merged tool in place of its sources: what the side with the fix is held to. */
  intended: string[] | null;
  /** The side with the fix did the run's work (its "Does what the run did" check); null when unscored. */
  doesTheWork: boolean | null;
  /** That check's reading in words ("stops short of what the run did"); null when unscored. */
  workDetail: string | null;
  /** The side without the fix took the recorded path, so the run is a baseline. */
  baseline: boolean;
  /** How each side ended, in words; null on results older than RC-76. */
  stops: { before: string; after: string } | null;
}

const STOP_WORDS: Record<ReplayStop, string> = {
  answered: "Answered",
  "step-cap": "Stopped at the step cap",
  "not-run": "Not replayed: no baseline",
};

/** The replay paths of one stored result. */
export function replayPathsOf(result: CaseResult | null): ReplayPathsView | null {
  const facts = result?.replay;
  if (!facts) return null;
  const notRun =
    facts.stops?.after === "not-run" ||
    (result.replayFailed === true && facts.paths.after.length === 0);
  const intended = facts.paths.intended ?? null;
  const work =
    result.after?.checks.find(
      (check) => check.kind === "does_the_work" && check.measured !== false,
    ) ?? null;
  return {
    recorded: facts.paths.recorded,
    before: facts.paths.before,
    after: notRun ? null : facts.paths.after,
    intended,
    doesTheWork: work ? work.pass : null,
    workDetail: work ? work.detail : null,
    baseline: facts.controlMatchesRecording,
    stops: facts.stops
      ? { before: STOP_WORDS[facts.stops.before], after: STOP_WORDS[facts.stops.after] }
      : null,
  };
}
