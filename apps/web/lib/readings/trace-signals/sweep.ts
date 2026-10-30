import { TURN_IDLE_CLOSE_MS } from "@/lib/ledger/constants";
import { dueProjectsInRotation } from "@/lib/readings/match-quality/sweep";
import { FIRST_READING_FLOOR } from "@/lib/readings/trace-signals/view";

/**
 * The daily signal sweep's policy, pure: whose turn it is. The drain step
 * around it (`sweep-service.ts`) does the I/O and the flag checks.
 *
 * Rotation reuses match quality's `dueProjectsInRotation` (least recently run
 * first, capped), with two adjustments made to the "last run" clock first:
 * - a live run (queued or running) counts as run when it started, so a fresh
 *   one keeps the project from being enqueued twice while one a crashed job
 *   left behind ages out instead of pinning the project forever (the sweep
 *   also reaps live runs past the stale threshold before it reads this);
 * - a completed run that read fewer turns than the first-reading floor, or
 *   that was the first reading (`first_build`), is due again once every turn
 *   open at the time has had its idle window to close (`THIN_RUN_RETRY_MS`)
 *   rather than a day later. The first reading lands as soon as the floor's
 *   worth of turns has closed, often while a first burst of traffic is still
 *   open; this one follow-up reads that burst in full, and from then on the
 *   project is on the daily rotation.
 */

export const SIGNAL_RUN_INTERVAL_MS = 24 * 60 * 60_000;
/**
 * How soon a thin run or a first reading is repeated: the idle-close window
 * (after which every turn open at the run has closed) plus five minutes for
 * the drain to have built them.
 */
export const THIN_RUN_RETRY_MS = TURN_IDLE_CLOSE_MS + 5 * 60_000;
/** Runs one tick may enqueue. */
export const MAX_SIGNAL_RUNS_PER_TICK = 10;
/** Due projects one tick looks at (flag checks are per project). */
export const MAX_SIGNAL_PROJECTS_SCANNED = MAX_SIGNAL_RUNS_PER_TICK * 4;
/** A project is a candidate when it has closed turns this recent. */
export const SWEEP_CANDIDATE_DAYS = 30;

export interface LatestRun {
  at: Date;
  /** When a live run actually started; `at` (its creation) when unknown. */
  startedAt?: Date | null;
  status: string;
  turnsScanned: number;
  /** What started the run; `first_build` marks a first reading. */
  trigger?: string;
}

/** The effective "last run" time per project the rotation compares against. */
export function effectiveLastRunAt(
  latest: ReadonlyMap<string, LatestRun>,
  now: Date,
  floor: number = FIRST_READING_FLOOR,
): Map<string, Date> {
  const out = new Map<string, Date>();
  for (const [projectId, run] of latest) {
    if (run.status === "queued" || run.status === "running") {
      const started = run.startedAt ?? run.at;
      out.set(projectId, started.getTime() > now.getTime() ? now : started);
    } else if (
      run.status === "completed" &&
      (run.turnsScanned < floor || run.trigger === "first_build")
    ) {
      out.set(projectId, new Date(run.at.getTime() - (SIGNAL_RUN_INTERVAL_MS - THIN_RUN_RETRY_MS)));
    } else {
      out.set(projectId, run.at);
    }
  }
  return out;
}

/** Candidates due a run, least recently run first, capped at the scan limit. */
export function dueSignalProjects(
  candidates: readonly string[],
  latest: ReadonlyMap<string, LatestRun>,
  now: Date,
  opts: { cap?: number; floor?: number } = {},
): string[] {
  return dueProjectsInRotation(candidates, effectiveLastRunAt(latest, now, opts.floor), now, {
    intervalMs: SIGNAL_RUN_INTERVAL_MS,
    cap: opts.cap ?? MAX_SIGNAL_PROJECTS_SCANNED,
  });
}

export interface SignalSweepResult {
  projectsScanned: number;
  runsEnqueued: number;
  skipped: boolean;
}

export const IDLE_SIGNAL_SWEEP: SignalSweepResult = {
  projectsScanned: 0,
  runsEnqueued: 0,
  skipped: true,
};
