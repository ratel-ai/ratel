import { getLogger } from "@/lib/platform/logger";
import {
  enqueueComputeJob as enqueueComputeJobFn,
  latestRunByProject as latestRunByProjectFn,
  listProjectsWithRecentTurns as listProjectsWithRecentTurnsFn,
  reapAllStaleSignalRuns as reapAllStaleSignalRunsFn,
  STALE_RUN_MS,
} from "@/lib/readings/trace-signals/signals/queries";
import {
  dueSignalProjects,
  IDLE_SIGNAL_SWEEP,
  MAX_SIGNAL_RUNS_PER_TICK,
  type SignalSweepResult,
  SWEEP_CANDIDATE_DAYS,
} from "@/lib/readings/trace-signals/sweep";

/**
 * The daily signal sweep, run as a registered step inside the per-minute cron drain.
 * Self-throttling: on almost every tick nothing is due and it returns the idle sentinel
 * after two cheap reads. It enqueues `compute_trace_signals` jobs (coalesced) and
 * returns; the drain runs them.
 *
 * Each tick first fails live runs older than the stale threshold, across all projects: a
 * run a crashed job left `running` is otherwise only reaped by the next compute job of
 * that project, which the sweep would never enqueue.
 *
 * Owned (ADR-0030): Agent health is on for every project here, so there is no per-project
 * gate and no organization read in the loop.
 */

const logger = getLogger("trace-signals/sweep");
const DAY_MS = 86_400_000;

export interface SignalSweepDeps {
  listCandidates: typeof listProjectsWithRecentTurnsFn;
  latestRuns: typeof latestRunByProjectFn;
  enqueue: typeof enqueueComputeJobFn;
  /** Fail every live run that started before the given time; returns how many. */
  reapStale: (before: Date, now: Date) => Promise<number>;
  now: () => Date;
}

export async function sweepTraceSignals(
  overrides: Partial<SignalSweepDeps> = {},
): Promise<SignalSweepResult> {
  const deps: SignalSweepDeps = {
    listCandidates: listProjectsWithRecentTurnsFn,
    latestRuns: latestRunByProjectFn,
    enqueue: enqueueComputeJobFn,
    reapStale: (before, now) => reapAllStaleSignalRunsFn(before, undefined, now),
    now: () => new Date(),
    ...overrides,
  };
  const now = deps.now();
  const reaped = await deps.reapStale(new Date(now.getTime() - STALE_RUN_MS), now);
  if (reaped > 0) {
    logger.warn(
      { runs_reaped: reaped, stale_after_ms: STALE_RUN_MS },
      "stale trace signal runs reaped",
    );
  }
  const candidates = await deps.listCandidates(
    new Date(now.getTime() - SWEEP_CANDIDATE_DAYS * DAY_MS),
  );
  if (candidates.length === 0) return IDLE_SIGNAL_SWEEP;
  const due = dueSignalProjects(candidates, await deps.latestRuns(), now);
  if (due.length === 0) return IDLE_SIGNAL_SWEEP;

  let runsEnqueued = 0;
  let projectsScanned = 0;
  for (const projectId of due) {
    if (runsEnqueued >= MAX_SIGNAL_RUNS_PER_TICK) break;
    projectsScanned += 1;
    if ((await deps.enqueue(projectId, "scheduled")) !== null) runsEnqueued += 1;
  }
  if (runsEnqueued === 0) return { ...IDLE_SIGNAL_SWEEP, projectsScanned };
  logger.info(
    { projects_scanned: projectsScanned, runs_enqueued: runsEnqueued },
    "trace signal sweep enqueued runs",
  );
  return { projectsScanned, runsEnqueued, skipped: false };
}
