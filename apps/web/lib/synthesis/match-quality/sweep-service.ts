import { eq, inArray } from "drizzle-orm";
import { enqueueJob } from "@/lib/jobs/queries";
import { getDb } from "@/lib/platform/db/client";
import { checkMeteredFeature } from "@/lib/platform/entitlements";
import { organizations } from "@/lib/platform/identity/schema";
import { getLogger } from "@/lib/platform/logger";
import { projects } from "@/lib/platform/projects/schema";
import {
  dueProjectsInRotation,
  IDLE_MATCH_QUALITY_SWEEP,
  MATCH_QUALITY_RUN_INTERVAL_MS,
  type SweepCandidate,
  type SweepResult,
  selectProjectsForSweep,
} from "@/lib/readings/match-quality/sweep";
import { JUDGE_BUDGET_USD } from "@/lib/synthesis/match-quality/judge";
import { listQualityProjects } from "@/lib/synthesis/quality/queries";
import { countRunsSince, lastCorpusChangeAt, lastRunByProject, startRun } from "./queries";
import { listSearchTelemetryProjects, resolveEvidenceSource } from "./search-source";
import {
  DEFAULT_RUN_WINDOW_DAYS,
  resolveRunWindow,
  startOfBillingPeriod,
  windowSinceLastChange,
} from "./window";

/**
 * The weekly pass, run as an isolated step inside the per-minute drain.
 *
 * Self-throttling rather than separately scheduled, matching
 * `refreshQualitySnapshots`: there is exactly one EventBridge rule in this
 * deployment and one cron route, and adding a second schedule for one feature
 * would be a new piece of infrastructure to operate for no behaviour we cannot
 * get from a `lastRunAt` comparison.
 *
 * It ENQUEUES and returns. Doing the analysis here would put a multi-second model
 * call inside the tick that also does retention.
 */

const logger = getLogger("match-quality/sweep");

/** Comparisons must exist in this window for a project to be worth a run. */
const CANDIDATE_WINDOW_DAYS = 30;

/** How often this process looks for due projects. */
export const SWEEP_EVERY_MS = 15 * 60 * 1000;
let lastSweepAt = 0;

export interface SweepDeps {
  db?: ReturnType<typeof getDb>;
  now?: Date;
  /** Bypass the interval gate. Used by tests and by a manual recompute. */
  force?: boolean;
}

/**
 * Scan for projects due a run and enqueue one each.
 *
 * Returns the IDLE sentinel when nothing is due, so the drain can report
 * `skipped` and stay quiet rather than emitting an event every minute.
 */
export async function sweepMatchQuality(deps: SweepDeps = {}): Promise<SweepResult> {
  const db = deps.db ?? getDb();
  const now = deps.now ?? new Date();
  // A project is due at most once a week, so looking every minute only cost
  // reads (RC-28). Forced runs and injected clocks (tests) always look.
  if (!deps.force && !deps.now && now.getTime() - lastSweepAt < SWEEP_EVERY_MS)
    return IDLE_MATCH_QUALITY_SWEEP;
  if (!deps.force && !deps.now) lastSweepAt = now.getTime();
  const window = resolveRunWindow(CANDIDATE_WINDOW_DAYS, now);

  // Projects with a calibration, and projects that only record their searches:
  // the answer key needs nothing more than the search text and Ratel's list.
  const [calibrated, searching] = await Promise.all([
    listQualityProjects(window, db),
    listSearchTelemetryProjects(window, db),
  ]);
  const active = [...new Set([...calibrated.map((row) => row.projectId), ...searching])];
  if (active.length === 0) return IDLE_MATCH_QUALITY_SWEEP;

  const lastRunAt = await lastRunByProject(db);

  // Whose turn it is, decided before any per-project query runs. On 10,079 of the
  // 10,080 ticks in a week this is empty and the pass ends here; on a cold start
  // every project is due at once, and the cap is what stops that becoming
  // hundreds of queries inside one tick.
  const due = dueProjectsInRotation(active, lastRunAt, now, {
    intervalMs: deps.force ? 0 : MATCH_QUALITY_RUN_INTERVAL_MS,
  });
  if (due.length === 0) return IDLE_MATCH_QUALITY_SWEEP;

  const rows = await db
    .select({
      projectId: projects.id,
      projectName: projects.name,
      organization: organizations,
    })
    .from(projects)
    .innerJoin(organizations, eq(projects.organizationId, organizations.id))
    .where(inArray(projects.id, due));

  const byProject = new Map(rows.map((row) => [row.projectId, row]));
  const candidates: SweepCandidate[] = [];
  for (const projectId of due) {
    const project = byProject.get(projectId);
    if (!project) continue;
    const source = await resolveEvidenceSource(projectId, window, db);
    if (!source) continue;
    candidates.push({
      projectId,
      organizationId: project.organization.id,
      projectName: project.projectName,
      experimentName: source.experimentName,
      comparisonCount: source.count,
    });
  }

  const eligible = new Map<string, boolean>();
  for (const candidate of candidates) {
    const project = byProject.get(candidate.projectId);
    if (!project) continue;
    const used = await countRunsSince(candidate.projectId, startOfBillingPeriod(now), db);
    const access = checkMeteredFeature(
      project.organization,
      "matchQualityRunsPerMonth",
      used,
      "Match quality",
    );
    eligible.set(candidate.projectId, access.ok);
  }

  const picked = selectProjectsForSweep(candidates, {
    isEligible: (candidate) => eligible.get(candidate.projectId) === true,
    lastRunAt,
    now,
    intervalMs: deps.force ? 0 : MATCH_QUALITY_RUN_INTERVAL_MS,
  });

  let runsEnqueued = 0;
  for (const candidate of picked) {
    const changedAt = await lastCorpusChangeAt(candidate.projectId, db);
    const days = windowSinceLastChange(changedAt, now, DEFAULT_RUN_WINDOW_DAYS);
    const runWindow = resolveRunWindow(days, now);
    const run = await startRun(
      {
        projectId: candidate.projectId,
        experimentName: candidate.experimentName,
        trigger: "scheduled",
        windowDays: days,
        windowStart: runWindow.since,
        windowEnd: runWindow.until,
      },
      db,
      now,
    );
    // Null means the project already has a live run: a manual click got there
    // first. Skipping is correct; two runs would race the same window.
    if (!run) continue;
    await enqueueJob(
      {
        projectId: candidate.projectId,
        kind: "match_quality_run",
        payload: {
          runId: run.id,
          projectId: candidate.projectId,
          projectName: candidate.projectName,
          experimentName: candidate.experimentName,
          windowStart: runWindow.since.toISOString(),
          windowEnd: runWindow.until.toISOString(),
          // The plan that let this project through buys the judge pass and the
          // backtest alike.
          judge: true,
          backtest: true,
          judgeBudgetUsd: JUDGE_BUDGET_USD.scheduled,
        },
      },
      db,
    );
    runsEnqueued += 1;
  }

  if (runsEnqueued === 0) return IDLE_MATCH_QUALITY_SWEEP;
  logger.info(
    { projects_scanned: candidates.length, runs_enqueued: runsEnqueued },
    "match quality sweep enqueued runs",
  );
  return { projectsScanned: candidates.length, runsEnqueued, skipped: false };
}
