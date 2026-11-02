import {
  type BackgroundObservability,
  createBackgroundObservability,
} from "@/lib/jobs/observability";
import { getAgentHealthLimits } from "@/lib/platform/entitlements";
import { getOrganizationByProjectId as getOrganizationByProjectIdFn } from "@/lib/platform/identity/queries";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";
import {
  computeToolExplorer as computeToolExplorerFn,
  EXPLORER_TIME_BUDGET_MS,
  explorerWindow,
  explorerWindowDays,
} from "@/lib/readings/tool-explorer/compute";
import {
  type ExplorerTrigger,
  enqueueExploreJob as enqueueExploreJobFn,
  failExplorerRun as failExplorerRunFn,
  persistExplorerRun as persistExplorerRunFn,
  reapStaleExplorerRuns as reapStaleExplorerRunsFn,
  startExplorerRun as startExplorerRunFn,
} from "@/lib/readings/tool-explorer/queries";
import { TimeBudgetError } from "@/lib/readings/trace-signals/signals/compute";
import { STALE_RUN_MS } from "@/lib/readings/trace-signals/signals/queries";

/**
 * The `explore_tool_usage` job: one tool explorer run for one project.
 *
 * Reap a live run a crashed job left behind, claim the project's one live run, walk the
 * ledger, persist edges, sets and the finished run in one transaction. A time-budget
 * overrun fails the run with `error = time_budget` and returns normally; any other failure
 * fails the run and rethrows so the job runner records and reports it. A completed run
 * queues the tool crafter through {@link exploreSeams}, so suggestions follow every reading
 * without anyone pressing a button.
 *
 * Logs and events carry counts only: no query text, no end-user ids.
 *
 * Owned (ADR-0030): the explorer runs for every project here, as the signal run does, so
 * there is no flag gate. The crafter (L5) is a reading of this reading: its registration
 * fills `enqueueCraft` when it lands, and a run with the seam unset simply queues nothing.
 */

const logger = getLogger("tool-explorer/job");
const SYSTEM_DISTINCT_ID = "system:tool-explorer";
const TRIGGERS: ReadonlySet<string> = new Set(["chained", "manual"]);

export interface ExploreJobPayload {
  trigger: ExplorerTrigger;
  signalRunId: string | null;
}

export interface ExploreJobDeps {
  getOrganizationByProjectId: typeof getOrganizationByProjectIdFn;
  reapStale: typeof reapStaleExplorerRunsFn;
  startRun: typeof startExplorerRunFn;
  failRun: typeof failExplorerRunFn;
  persist: typeof persistExplorerRunFn;
  compute: typeof computeToolExplorerFn;
  observability: Pick<BackgroundObservability, "trackSystemEvent">;
  /** Queue the crafting run that reads this run's edges, sets and asks; a seam the crafter's registration fills. */
  enqueueCraft?: (projectId: string) => Promise<unknown>;
  /** Queue this job again, when a live run kept it from starting; coalesced with any job already queued. */
  requeue: (projectId: string, payload: ExploreJobPayload) => Promise<unknown>;
  now: () => Date;
  timeBudgetMs: number;
}

/**
 * The enqueue of the reading that follows an explorer run. Empty until the tool crafter's
 * registration assigns it, so this module never imports a synthesis that may not have landed.
 */
export const exploreSeams: Pick<ExploreJobDeps, "enqueueCraft"> = {};

function defaultDeps(): ExploreJobDeps {
  return {
    getOrganizationByProjectId: getOrganizationByProjectIdFn,
    reapStale: reapStaleExplorerRunsFn,
    startRun: startExplorerRunFn,
    failRun: failExplorerRunFn,
    persist: persistExplorerRunFn,
    compute: computeToolExplorerFn,
    observability: createBackgroundObservability(),
    ...exploreSeams,
    requeue: (projectId, payload) =>
      enqueueExploreJobFn(projectId, payload.trigger, payload.signalRunId),
    now: () => new Date(),
    timeBudgetMs: EXPLORER_TIME_BUDGET_MS,
  };
}

export type ExploreJobOutcome = "completed" | "time_budget" | "busy";

export interface ExploreJobResult {
  outcome: ExploreJobOutcome;
  runId: string | null;
  windowDays: number;
  turnsScanned: number;
  sessionsScanned: number;
  edges: number;
  sets: number;
}

const EMPTY = {
  runId: null,
  windowDays: 0,
  turnsScanned: 0,
  sessionsScanned: 0,
  edges: 0,
  sets: 0,
};

/** The payload a job carries, defaulting to a chained run with no signal run named. */
export function parseExplorePayload(payload: unknown): ExploreJobPayload {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const trigger =
    typeof record.trigger === "string" && TRIGGERS.has(record.trigger)
      ? (record.trigger as ExplorerTrigger)
      : "chained";
  const signalRunId = typeof record.signalRunId === "string" ? record.signalRunId : null;
  return { trigger, signalRunId };
}

export async function exploreProjectToolUsage(
  projectId: string,
  payload: ExploreJobPayload,
  overrides: Partial<ExploreJobDeps> = {},
): Promise<ExploreJobResult> {
  const deps = { ...defaultDeps(), ...overrides };
  const organization = await deps.getOrganizationByProjectId(projectId);

  const startedAt = deps.now();
  await deps.reapStale(
    projectId,
    new Date(startedAt.getTime() - STALE_RUN_MS),
    undefined,
    startedAt,
  );
  const days = explorerWindowDays(
    organization ? getAgentHealthLimits(organization).agentHealthWindowDays : 0,
  );
  const window = explorerWindow(startedAt, days);
  const run = await deps.startRun(
    {
      projectId,
      trigger: payload.trigger,
      windowDays: days,
      windowStart: window.start,
      windowEnd: window.end,
      signalRunId: payload.signalRunId,
    },
    undefined,
    startedAt,
  );
  if (!run) {
    // A live run is on the window already, and the queued index coalesces queued jobs
    // only, so this one would be lost: queue it again for the next drain, so the reading
    // after that run still happens.
    await requeueBehindLiveRun(projectId, payload, deps);
    return { outcome: "busy", ...EMPTY, windowDays: days };
  }

  const base = {
    project_id: projectId,
    run_id: run.id,
    trigger: payload.trigger,
    window_days: days,
  };
  try {
    const { result, pages } = await deps.compute(projectId, window, {
      now: deps.now,
      timeBudgetMs: deps.timeBudgetMs,
    });
    const finishedAt = deps.now();
    await deps.persist({
      runId: run.id,
      projectId,
      edges: result.edges,
      sets: result.sets,
      intentTools: result.intentTools,
      summary: result.summary,
      turnsScanned: result.turnsScanned,
      sessionsScanned: result.sessionsScanned,
      turnsWithIntents: result.turnsWithIntents,
      now: finishedAt,
    });
    const fields = {
      ...base,
      pages,
      turns_scanned: result.turnsScanned,
      sessions_scanned: result.sessionsScanned,
      edges: result.edges.length,
      sets: result.sets.length,
      turns_with_intents: result.turnsWithIntents,
      intent_tool_rows: result.intentTools.length,
      sessions_truncated: result.summary.truncated.sessions,
      duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    };
    if (result.summary.truncated.sessions) {
      logger.warn(base, "tool explorer session fold hit its caps");
    }
    logger.info(fields, "tool explorer run completed");
    await queueToolCrafter(projectId, deps);
    await deps.observability.trackSystemEvent("tool_explorer_run_completed", SYSTEM_DISTINCT_ID, {
      object_action: "tool_explorer_run_completed",
      ...fields,
    });
    return {
      outcome: "completed",
      runId: run.id,
      windowDays: days,
      turnsScanned: result.turnsScanned,
      sessionsScanned: result.sessionsScanned,
      edges: result.edges.length,
      sets: result.sets.length,
    };
  } catch (err) {
    const overBudget = err instanceof TimeBudgetError;
    const failedAt = deps.now();
    await deps.failRun(
      run.id,
      overBudget ? "time_budget" : err instanceof Error ? err.message : String(err),
      undefined,
      failedAt,
    );
    const fields = {
      ...base,
      error: overBudget ? "time_budget" : "error",
      duration_ms: Math.max(0, failedAt.getTime() - startedAt.getTime()),
    };
    if (overBudget) logger.warn(fields, "tool explorer run over time budget");
    else logger.error({ ...fields, err }, "tool explorer run failed");
    await deps.observability.trackSystemEvent("tool_explorer_run_failed", SYSTEM_DISTINCT_ID, {
      object_action: "tool_explorer_run_failed",
      ...fields,
    });
    if (overBudget) return { outcome: "time_budget", ...EMPTY, runId: run.id, windowDays: days };
    throw err;
  }
}

/** Best-effort: a job that could not be queued again is logged and reported, never thrown, so the drain moves on. */
async function requeueBehindLiveRun(
  projectId: string,
  payload: ExploreJobPayload,
  deps: Pick<ExploreJobDeps, "requeue">,
): Promise<void> {
  try {
    const queued = await deps.requeue(projectId, payload);
    logger.info(
      { project_id: projectId, trigger: payload.trigger, coalesced: queued === null },
      "tool explorer run deferred behind a live run",
    );
  } catch (err) {
    logger.error(
      { err, project_id: projectId, trigger: payload.trigger },
      "tool explorer requeue failed",
    );
    reportServerException(err, `project:${projectId}`, {
      operation: "explore_tool_usage_requeue",
    });
  }
}

/** Best-effort: the crafter is a reading of this reading, so a failed enqueue never fails the run. */
async function queueToolCrafter(
  projectId: string,
  deps: Pick<ExploreJobDeps, "enqueueCraft">,
): Promise<void> {
  try {
    await deps.enqueueCraft?.(projectId);
  } catch (err) {
    logger.error({ err, project_id: projectId }, "tool craft enqueue failed");
    reportServerException(err, `project:${projectId}`, { operation: "craft_tools_enqueue" });
  }
}
