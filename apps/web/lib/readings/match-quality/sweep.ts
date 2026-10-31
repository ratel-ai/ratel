/**
 * The project rotation a periodic reading uses to decide whose turn it is, and the
 * match-quality sweep's policy over it.
 *
 * Pure. The drain step around it does the I/O; this decides, so the policy (who is
 * eligible, whose turn it is, how many at once) is testable without a database and
 * readable in one place.
 *
 * It ENQUEUES rather than runs. The drain fires every minute and a run makes a model
 * call, so doing the work inline would put a multi-second request inside the tick that
 * also does retention. The job queue already handles claiming, staleness reaping and
 * retry, so the sweep's whole job is to decide.
 *
 * Owned (ADR-0030): the signal sweep reads `dueProjectsInRotation` from here before the
 * match-quality reading lands; the run trigger is inlined because upstream's
 * match-quality types import a higher-layer module.
 */

/** Why a match-quality run was asked for. */
export type RunTrigger = "scheduled" | "manual";

/** Weekly, matching the cadence the surface promises. */
export const MATCH_QUALITY_RUN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many projects one pass may enqueue.
 *
 * Small, because each enqueued job is a model call. The cap is spent as a ROTATION, not a
 * truncation: least-recently-run first, so a project can never be starved by another
 * whose traffic happens to sort it higher.
 */
export const MAX_PROJECTS_PER_SWEEP = 5;

/**
 * How many due projects one pass will look at closely.
 *
 * Deciding whether a project is eligible costs a few queries, and on a cold start every
 * project is due at once, so an unbounded scan puts hundreds of queries inside a
 * per-minute tick that also does retention. Wider than {@link MAX_PROJECTS_PER_SWEEP} so
 * a pass can still fill its quota when some of what it looks at turns out to be
 * ineligible, and bounded so the cost of a tick never depends on how many projects exist.
 *
 * What makes the cap safe rather than starving is that it is spent in rotation order: a
 * project skipped this minute sorts first the next.
 */
export const MAX_PROJECTS_SCANNED_PER_SWEEP = MAX_PROJECTS_PER_SWEEP * 4;

/**
 * Due projects, least-recently-run first, capped.
 *
 * Split out from {@link selectProjectsForSweep} because it runs BEFORE the per-project
 * queries rather than after them: ordering is the whole reason the scan cap does not
 * starve anyone, so it has to be applied while the only thing known about a project is
 * its id.
 */
export function dueProjectsInRotation(
  projectIds: readonly string[],
  lastRunAt: ReadonlyMap<string, Date>,
  now: Date,
  opts: { intervalMs?: number; cap?: number } = {},
): string[] {
  const interval = opts.intervalMs ?? MATCH_QUALITY_RUN_INTERVAL_MS;
  const cap = opts.cap ?? MAX_PROJECTS_SCANNED_PER_SWEEP;
  return [...projectIds]
    .filter((projectId) => {
      const last = lastRunAt.get(projectId);
      return last === undefined || now.getTime() - last.getTime() >= interval;
    })
    .sort((left, right) => {
      const leftAt = lastRunAt.get(left)?.getTime() ?? 0;
      const rightAt = lastRunAt.get(right)?.getTime() ?? 0;
      return leftAt - rightAt || compare(left, right);
    })
    .slice(0, cap);
}

export interface SweepCandidate {
  projectId: string;
  organizationId: string;
  projectName: string;
  experimentName: string;
  /** Comparisons in the default window: zero means there is nothing to read. */
  comparisonCount: number;
}

export interface SweepDecision extends SweepCandidate {
  trigger: RunTrigger;
}

export interface SweepPolicy {
  /** Whether the organization's plan and flag allow a run to be spent right now. */
  isEligible: (candidate: SweepCandidate) => boolean;
  lastRunAt: ReadonlyMap<string, Date>;
  now: Date;
  cap?: number;
  intervalMs?: number;
}

/**
 * Pick this pass's projects.
 *
 * A project with no comparisons in the window is skipped before eligibility is even
 * consulted: enqueuing a job that will certainly decline spends a job slot and writes a
 * run row saying nothing, every week, forever.
 */
export function selectProjectsForSweep(
  candidates: readonly SweepCandidate[],
  policy: SweepPolicy,
): SweepDecision[] {
  const interval = policy.intervalMs ?? MATCH_QUALITY_RUN_INTERVAL_MS;
  const cap = policy.cap ?? MAX_PROJECTS_PER_SWEEP;

  return [...candidates]
    .filter((candidate) => candidate.comparisonCount > 0)
    .filter((candidate) => {
      const last = policy.lastRunAt.get(candidate.projectId);
      if (last === undefined) return true;
      return policy.now.getTime() - last.getTime() >= interval;
    })
    .filter((candidate) => policy.isEligible(candidate))
    .sort((left, right) => {
      // Never run sorts to zero, which is before every real timestamp.
      const leftAt = policy.lastRunAt.get(left.projectId)?.getTime() ?? 0;
      const rightAt = policy.lastRunAt.get(right.projectId)?.getTime() ?? 0;
      return leftAt - rightAt || compare(left.projectId, right.projectId);
    })
    .slice(0, cap)
    .map((candidate) => ({ ...candidate, trigger: "scheduled" as const }));
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface SweepResult {
  projectsScanned: number;
  runsEnqueued: number;
  skipped: boolean;
}

export const IDLE_MATCH_QUALITY_SWEEP: SweepResult = {
  projectsScanned: 0,
  runsEnqueued: 0,
  skipped: true,
};
