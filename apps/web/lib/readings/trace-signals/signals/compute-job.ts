import {
  type BackgroundObservability,
  createBackgroundObservability,
} from "@/lib/jobs/observability";
import { countClosedTurns as countClosedTurnsFn } from "@/lib/ledger/closed-turns";
import { TURN_BUILD_SEED_WINDOW_DAYS } from "@/lib/ledger/constants";
import {
  countUnbuiltTurnEvents as countUnbuiltTurnEventsFn,
  getTraceTurnsCursor as getTraceTurnsCursorFn,
} from "@/lib/ledger/turns/queries";
import { getAgentHealthLimits } from "@/lib/platform/entitlements";
import { getOrganizationByProjectId as getOrganizationByProjectIdFn } from "@/lib/platform/identity/queries";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";
import { configured, decisionEngineConfigured } from "@/lib/readings/decisions/engine";
import type {
  SelfCorrectionRunInput,
  SelfCorrectionRunResult,
} from "@/lib/readings/trace-signals/self-corrections/run";
import {
  recordSelfCorrectionsForRun,
  type SelfCorrectionBudget,
} from "@/lib/readings/trace-signals/self-corrections/run-job";
import {
  buildSetupFacts,
  type SetupLinking,
  type StoredSetup,
} from "@/lib/readings/trace-signals/setup-facts";
import { loadSetupCounts as loadSetupCountsFn } from "@/lib/readings/trace-signals/setup-facts-query";
import { countFixesSince as countFixesSinceFn } from "@/lib/readings/trace-signals/signals/analysis-context";
import { MAX_QUERY_HASHES } from "@/lib/readings/trace-signals/signals/catalog";
import {
  computeSignals as computeSignalsFn,
  resolveWindowDays,
  SIGNAL_TIME_BUDGET_MS,
  signalWindow,
  TimeBudgetError,
  targetWindowDays,
} from "@/lib/readings/trace-signals/signals/compute";
import {
  type AwaitedFix,
  arrivedFix,
  awaitedFixes,
  fixRerunDue,
} from "@/lib/readings/trace-signals/signals/data-fixes";
import {
  enqueueComputeJob as enqueueComputeJobFn,
  failSignalRun as failSignalRunFn,
  isRunTrigger,
  latestSignalRun as latestSignalRunFn,
  persistSignalRun as persistSignalRunFn,
  type RunTrigger,
  reapStaleSignalRuns as reapStaleSignalRunsFn,
  STALE_RUN_MS,
  startSignalRun as startSignalRunFn,
} from "@/lib/readings/trace-signals/signals/queries";
import { FIRST_READING_FLOOR } from "@/lib/readings/trace-signals/view";
import { enqueueLabelWorkflowsJob as enqueueLabelWorkflowsJobFn } from "@/lib/readings/trace-signals/workflows/label-queries";
import {
  type PlacementWriteResult,
  writeTaskPlacement as writeTaskPlacementFn,
} from "@/lib/readings/trace-signals/workflows/place-queries";

/**
 * The `compute_trace_signals` job: one signal run for one project.
 *
 * Reap a live run a crashed job left behind, pick the window (shrunk after a time-budget
 * failure), claim the project's one live run, run the detectors over the ledger, and
 * persist signals and the finished run in one transaction. A time-budget overrun fails
 * the run with `error = time_budget` and returns normally (the next run shrinks the
 * window); any other failure fails the run, is tracked, and rethrows so the job runner
 * records and reports it.
 *
 * A run that starts while turn events still wait to be built records how many
 * (`summary.unbuiltAtStart`) when that is enough to change its numbers, so the page can
 * ask for another once they are built.
 *
 * Logs and events carry counts only: no query text, no end-user ids.
 *
 * Owned (ADR-0030): Agent health is on for every project here, so there is no flag gate.
 * The readings that follow a run (topics, the tool explorer) are seams: each one's
 * registration fills its enqueue in {@link computeSeams} when it lands, and a run with
 * the seam unset simply queues nothing.
 */

const logger = getLogger("trace-signals/compute-job");
const SYSTEM_DISTINCT_ID = "system:trace-signals";

type Env = Record<string, string | undefined>;

export interface ComputeJobDeps {
  getOrganizationByProjectId: typeof getOrganizationByProjectIdFn;
  getCursor: typeof getTraceTurnsCursorFn;
  latestRun: typeof latestSignalRunFn;
  reapStale: typeof reapStaleSignalRunsFn;
  startRun: typeof startSignalRunFn;
  failRun: typeof failSignalRunFn;
  persist: typeof persistSignalRunFn;
  compute: typeof computeSignalsFn;
  observability: Pick<BackgroundObservability, "trackSystemEvent">;
  /** What the project sends, per data point, for the page's setup card. */
  loadSetupCounts: typeof loadSetupCountsFn;
  /** Queue model-written workflow names after a run that found workflows. */
  enqueueLabels: (projectId: string) => Promise<unknown>;
  /** Whether a model is configured to name workflows or place asks in them. */
  canLabel: () => boolean;
  /** Turn events received after `since` (the build cursor) and not yet built, up to a cap. */
  countUnbuilt: (projectId: string, since: Date | string) => Promise<number>;
  /** Write each run's task (`trace_turns.workflow_id`) for the window's runs. */
  writePlacement: typeof writeTaskPlacementFn;
  /**
   * The window's self-corrections (`self-corrections/run.ts`): rewrites its
   * `trace_self_corrections` rows and finds the `self_correcting` issues, which join this
   * run's signals.
   */
  recordSelfCorrections: (
    projectId: string,
    input: SelfCorrectionRunInput,
    budget: SelfCorrectionBudget,
  ) => Promise<SelfCorrectionRunResult>;
  /** Queue the topic reading that follows every run; a seam the topics registration fills. */
  enqueueTopics?: (projectId: string) => Promise<unknown>;
  /** Queue the tool-explorer run that reads this run's ledger window; a seam its registration fills. */
  enqueueExplore?: (projectId: string, signalRunId: string) => Promise<unknown>;
  now: () => Date;
  timeBudgetMs: number;
}

/**
 * The enqueues of the readings that follow a signal run. Empty until their registrations
 * assign them, so this module never imports a reading that may not have landed.
 */
export const computeSeams: Pick<ComputeJobDeps, "enqueueTopics" | "enqueueExplore"> = {};

/** The turn build's seed window: what a project's first build reads. */
const SEED_WINDOW_MS = TURN_BUILD_SEED_WINDOW_DAYS * 86_400_000;
/** Unbuilt turn events counted at most: one build page. */
export const UNBUILT_COUNT_CAP = 5_000;
/** The fewest unbuilt events at a run's start that make it partial, whatever its size. */
export const PARTIAL_READING_MIN_EVENTS = 20;

/**
 * Whether a run that started with `unbuilt` turn events still waiting to be built missed
 * enough to change its numbers: at least `PARTIAL_READING_MIN_EVENTS`, and a tenth of
 * the turns it read. The few seconds of ingest a busy project always has in flight are
 * neither.
 */
export function missedBacklog(unbuilt: number, turnsScanned: number): boolean {
  return unbuilt >= Math.max(PARTIAL_READING_MIN_EVENTS, Math.ceil(turnsScanned / 10));
}

function defaultDeps(env: Env): ComputeJobDeps {
  return {
    getOrganizationByProjectId: getOrganizationByProjectIdFn,
    getCursor: getTraceTurnsCursorFn,
    latestRun: latestSignalRunFn,
    reapStale: reapStaleSignalRunsFn,
    startRun: startSignalRunFn,
    failRun: failSignalRunFn,
    persist: persistSignalRunFn,
    compute: computeSignalsFn,
    observability: createBackgroundObservability(),
    loadSetupCounts: (projectId, window) => loadSetupCountsFn(projectId, window),
    enqueueLabels: (projectId) => enqueueLabelWorkflowsJobFn(projectId),
    canLabel: () => !!configured(env.ANTHROPIC_API_KEY) || decisionEngineConfigured(env),
    countUnbuilt: (projectId, since) =>
      countUnbuiltTurnEventsFn(projectId, since, UNBUILT_COUNT_CAP),
    writePlacement: (projectId, input) => writeTaskPlacementFn(projectId, input),
    recordSelfCorrections: recordSelfCorrectionsForRun,
    ...computeSeams,
    now: () => new Date(),
    timeBudgetMs: SIGNAL_TIME_BUDGET_MS,
  };
}

export type ComputeJobOutcome = "completed" | "time_budget" | "busy";

export interface ComputeJobResult {
  outcome: ComputeJobOutcome;
  runId: string | null;
  windowDays: number;
  turnsScanned: number;
  signalsOpen: number;
  signalsNew: number;
  signalsResolved: number;
}

const EMPTY = {
  runId: null,
  windowDays: 0,
  turnsScanned: 0,
  signalsOpen: 0,
  signalsNew: 0,
  signalsResolved: 0,
};

/** The trigger a job payload names, defaulting to `scheduled` for anything unknown. */
export function parseComputePayload(payload: unknown): { trigger: RunTrigger } {
  const trigger =
    payload && typeof payload === "object" ? (payload as { trigger?: unknown }).trigger : undefined;
  return { trigger: isRunTrigger(trigger) ? trigger : "scheduled" };
}

export async function computeProjectTraceSignals(
  projectId: string,
  payload: { trigger: RunTrigger },
  overrides: Partial<ComputeJobDeps> = {},
  env: Env = process.env,
): Promise<ComputeJobResult> {
  const deps = { ...defaultDeps(env), ...overrides };
  const organization = await deps.getOrganizationByProjectId(projectId);

  const startedAt = deps.now();
  await deps.reapStale(
    projectId,
    new Date(startedAt.getTime() - STALE_RUN_MS),
    undefined,
    startedAt,
  );
  const previous = await deps.latestRun(projectId);
  const planDays = organization ? getAgentHealthLimits(organization).agentHealthWindowDays : 0;
  const days = resolveWindowDays(previous, planDays, deps.timeBudgetMs);
  const windowShrunk = days < targetWindowDays(planDays);
  const window = signalWindow(startedAt, days);
  const cursor = await deps.getCursor(projectId);
  // Never built yet: everything in the build's seed window is still waiting.
  const builtThrough = cursor?.raw ?? new Date(startedAt.getTime() - SEED_WINDOW_MS);
  const unbuiltAtStart = await unbuiltFor(projectId, builtThrough, deps);
  const run = await deps.startRun(
    {
      projectId,
      trigger: payload.trigger,
      windowDays: days,
      windowStart: window.start,
      windowEnd: window.end,
      ledgerThrough: cursor?.at ?? null,
    },
    undefined,
    startedAt,
  );
  if (!run) return { outcome: "busy", ...EMPTY, windowDays: days };

  const base = {
    project_id: projectId,
    run_id: run.id,
    trigger: payload.trigger,
    window_days: days,
  };
  try {
    const { result, fingerprint } = await deps.compute(projectId, window, {
      now: deps.now,
      timeBudgetMs: deps.timeBudgetMs,
    });
    // The alert is for workflows hidden by mixed runs; once turn ids carry the reading it has nothing to say.
    const basis = result.summary.workflows?.basis;
    // A reading of the fixed runs says what is sent since the fix, not what the older runs lacked.
    const since = basis?.basis === "exact" && basis.since ? new Date(basis.since) : null;
    const setupWindow = since && since > window.start ? { ...window, start: since } : window;
    const setup = await setupFor(
      projectId,
      setupWindow,
      deps,
      result.linking,
      basis?.blocked === "mixed_runs",
    );
    // Each run's task first: the self-corrections read it from the runs, and the jobs this
    // run queues (names, the tool reading) read every run's task.
    const placement = await writePlacementFor(projectId, window, result.placement, deps);
    const corrections = await selfCorrectionsFor(
      projectId,
      window,
      result.summary,
      startedAt,
      deps,
    );
    const finishedAt = deps.now();
    const partial = missedBacklog(unbuiltAtStart, result.turnsScanned);
    const persisted = await deps.persist({
      runId: run.id,
      projectId,
      signals: corrections ? [...result.signals, ...corrections.signals] : result.signals,
      measured: corrections
        ? new Set([...result.measured, ...corrections.measured])
        : result.measured,
      summary: {
        ...result.summary,
        ...(windowShrunk ? { windowShrunk } : {}),
        ...(setup ? { setup } : {}),
        ...(partial ? { unbuiltAtStart } : {}),
        ...(corrections ? { selfCorrections: corrections.stored } : {}),
      },
      turnsScanned: result.turnsScanned,
      turnSourceMix: result.turnSourceMix,
      corpusFingerprint: fingerprint,
      now: finishedAt,
    });
    const fields = {
      ...base,
      turns_scanned: result.turnsScanned,
      runs_placed: placement?.placed ?? null,
      placement_written: placement ? placement.set + placement.cleared : null,
      unbuilt_at_start: unbuiltAtStart,
      signals_open: persisted.open,
      signals_new: persisted.opened,
      signals_resolved: persisted.resolved,
      pair_tools: result.pairTools,
      queries_truncated: result.queriesEvicted > 0,
      self_corrections: corrections?.stored.events ?? null,
      self_correcting_issues: corrections?.signals.length ?? null,
      duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    };
    if (result.queriesEvicted > 0) {
      logger.warn(
        {
          ...base,
          query_hashes_evicted: result.queriesEvicted,
          max_query_hashes: MAX_QUERY_HASHES,
        },
        "trace signal query hashes truncated",
      );
    }
    logger.info(fields, "trace signal run completed");
    await queueWorkflowLabels(projectId, result.summary, deps);
    await queueTopics(projectId, deps);
    await queueToolExplorer(projectId, run.id, deps);
    await deps.observability.trackSystemEvent("trace_signal_run_completed", SYSTEM_DISTINCT_ID, {
      object_action: "trace_signal_run_completed",
      ...fields,
    });
    return {
      outcome: "completed",
      runId: run.id,
      windowDays: days,
      turnsScanned: result.turnsScanned,
      signalsOpen: persisted.open,
      signalsNew: persisted.opened,
      signalsResolved: persisted.resolved,
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
    if (overBudget) logger.warn(fields, "trace signal run over time budget");
    else logger.error({ ...fields, err }, "trace signal run failed");
    await deps.observability.trackSystemEvent("trace_signal_run_failed", SYSTEM_DISTINCT_ID, {
      object_action: "trace_signal_run_failed",
      ...fields,
    });
    if (overBudget) return { outcome: "time_budget", ...EMPTY, runId: run.id, windowDays: days };
    throw err;
  }
}

/**
 * Best-effort: self-corrections are one more reading of the same window, so a failure or
 * a time-budget overrun never fails the run. Their issue kind then stays unmeasured, so an
 * open one is not resolved by a reading that did not see it, and the window keeps its
 * earlier rows.
 */
async function selfCorrectionsFor(
  projectId: string,
  window: { start: Date; end: Date },
  summary: { workflows?: { items: readonly { id: string; typicalOrder: readonly string[] }[] } },
  startedAt: Date,
  deps: Pick<ComputeJobDeps, "recordSelfCorrections" | "now" | "timeBudgetMs">,
): Promise<SelfCorrectionRunResult | null> {
  const tasks = new Map(
    (summary.workflows?.items ?? []).map((item) => [item.id, item.typicalOrder] as const),
  );
  try {
    return await deps.recordSelfCorrections(
      projectId,
      { window: { start: window.start, end: window.end }, tasks },
      { startedAt: startedAt.getTime(), now: deps.now, timeBudgetMs: deps.timeBudgetMs },
    );
  } catch (err) {
    if (err instanceof TimeBudgetError) {
      logger.warn({ project_id: projectId }, "self corrections reading over time budget");
      return null;
    }
    logger.error({ err, project_id: projectId }, "self corrections reading failed");
    reportServerException(err, `project:${projectId}`, {
      operation: "trace_signals_self_corrections",
    });
    return null;
  }
}

/** Best-effort: the backlog only marks a reading partial, so a failed count never fails the run. */
async function unbuiltFor(
  projectId: string,
  since: Date | string,
  deps: Pick<ComputeJobDeps, "countUnbuilt">,
): Promise<number> {
  try {
    return await deps.countUnbuilt(projectId, since);
  } catch (err) {
    logger.error(
      { err, project_id: projectId },
      "unbuilt turn events unreadable for trace signals",
    );
    reportServerException(err, `project:${projectId}`, {
      operation: "trace_signals_unbuilt_count",
    });
    return 0;
  }
}

/**
 * Best-effort: the run's own numbers are stored already; a failed write leaves the
 * window's runs on the tasks the previous run gave them until the next run.
 */
async function writePlacementFor(
  projectId: string,
  window: { start: Date; end: Date },
  placement: ReadonlyMap<string, string | null>,
  deps: Pick<ComputeJobDeps, "writePlacement">,
): Promise<PlacementWriteResult | null> {
  try {
    return await deps.writePlacement(projectId, {
      window: { start: window.start, end: window.end },
      placement,
    });
  } catch (err) {
    logger.error(
      { err, project_id: projectId, runs: placement.size },
      "task placement write failed",
    );
    reportServerException(err, `project:${projectId}`, {
      operation: "trace_signals_task_placement",
    });
    return null;
  }
}

/** Best-effort: the setup card is guidance, so a failed read never fails the run. */
async function setupFor(
  projectId: string,
  window: { start: Date; end: Date },
  deps: Pick<ComputeJobDeps, "loadSetupCounts">,
  linking?: SetupLinking,
  mixedRuns = false,
): Promise<StoredSetup | null> {
  try {
    return buildSetupFacts(await deps.loadSetupCounts(projectId, window), linking, { mixedRuns });
  } catch (err) {
    logger.error({ err, project_id: projectId }, "setup facts unreadable for trace signals");
    reportServerException(err, `project:${projectId}`, { operation: "trace_signals_setup_facts" });
    return null;
  }
}

/** Best-effort: names are a nicety, so a failed enqueue never fails the run. */
async function queueWorkflowLabels(
  projectId: string,
  summary: { workflows?: { items: readonly unknown[] } },
  deps: Pick<ComputeJobDeps, "enqueueLabels" | "canLabel">,
): Promise<void> {
  if (!summary.workflows || summary.workflows.items.length === 0 || !deps.canLabel()) return;
  try {
    await deps.enqueueLabels(projectId);
  } catch (err) {
    logger.error({ err, project_id: projectId }, "workflow label enqueue failed");
    reportServerException(err, `project:${projectId}`, { operation: "label_workflows_enqueue" });
  }
}

/** Best-effort: topics are another reading of the same turns, so a failed enqueue never fails the run. */
async function queueTopics(
  projectId: string,
  deps: Pick<ComputeJobDeps, "enqueueTopics">,
): Promise<void> {
  try {
    await deps.enqueueTopics?.(projectId);
  } catch (err) {
    logger.error({ err, project_id: projectId }, "topic reading enqueue failed");
    reportServerException(err, `project:${projectId}`, { operation: "assign_topics_enqueue" });
  }
}

/** Best-effort: the explorer is a second reading of the same ledger, so a failed enqueue never fails the run. */
async function queueToolExplorer(
  projectId: string,
  signalRunId: string,
  deps: Pick<ComputeJobDeps, "enqueueExplore">,
): Promise<void> {
  try {
    await deps.enqueueExplore?.(projectId, signalRunId);
  } catch (err) {
    logger.error({ err, project_id: projectId }, "tool explorer enqueue failed");
    reportServerException(err, `project:${projectId}`, { operation: "explore_tool_usage_enqueue" });
  }
}

export interface FirstBuildDeps {
  latestRun: typeof latestSignalRunFn;
  enqueue: typeof enqueueComputeJobFn;
  countClosed: (projectId: string, from: Date, to: Date) => Promise<number>;
  /** Fixed rows since a reading, per awaited fix. */
  countFixes: (
    projectId: string,
    since: Date,
    fixes: readonly AwaitedFix[],
  ) => Promise<Partial<Record<AwaitedFix, number>>>;
  now: () => Date;
  /** Closed turns a first reading needs; the page's collecting meter counts to the same number. */
  floor: number;
}

/** Closed turns are counted over the build's seed window, which every run window covers. */
const FIRST_READING_LOOKBACK_MS = SEED_WINDOW_MS;

/**
 * Whether a project still waits for its first reading: it has no run yet, or its latest
 * run completed on fewer closed turns than the floor (a thin run the page reads as
 * "collecting"). A live or failed run is left alone.
 */
function awaitsFirstReading(
  latest: Awaited<ReturnType<typeof latestSignalRunFn>>,
  floor: number,
): boolean {
  if (!latest) return true;
  return latest.status === "completed" && latest.turnsScanned < floor;
}

/**
 * A completed reading made on incomplete data, once enough fixed data arrived since
 * (`data-fixes.ts`): enqueue a run with `trigger = data_fixed`, so a project that turns
 * on turn ids, tool calls or users' messages sees the page read from the fixed runs within
 * the hour.
 */
async function enqueueFixedReading(
  projectId: string,
  latest: NonNullable<Awaited<ReturnType<typeof latestSignalRunFn>>>,
  deps: FirstBuildDeps,
): Promise<boolean> {
  if (latest.status !== "completed" || !latest.finishedAt || !fixRerunDue(latest, deps.now())) {
    return false;
  }
  const awaited = awaitedFixes(latest.summary);
  if (awaited.length === 0) return false;
  const fix = arrivedFix(awaited, await deps.countFixes(projectId, latest.finishedAt, awaited));
  if (!fix) return false;
  const queued = (await deps.enqueue(projectId, "data_fixed")) !== null;
  if (queued)
    logger.info({ project_id: projectId, fix }, "trace signal rerun queued after a data fix");
  return queued;
}

/**
 * The turn builder's `onBacklogDrained` hook (filled into the ledger's seams by
 * `register.ts`), called whenever a build catches up after writing turns or closing idle
 * ones: once a project that still awaits its first reading has `FIRST_READING_FLOOR`
 * closed turns, enqueue a run with `trigger = first_build`, so a new project sees signals
 * minutes after enough turns close instead of at the next sweep. A project past its first
 * reading gets a new one when the data its last reading lacked has arrived
 * (`enqueueFixedReading`). Before the floor it does nothing, so a first ingest batch
 * whose turns are still open does not spend the first reading on a handful of turns.
 * Coalesced like every compute enqueue. Never throws: a failed enqueue is logged and
 * reported, and the sweep is the backstop.
 */
export async function enqueueFirstSignalRun(
  projectId: string,
  overrides: Partial<FirstBuildDeps> = {},
): Promise<boolean> {
  const deps: FirstBuildDeps = {
    latestRun: latestSignalRunFn,
    enqueue: enqueueComputeJobFn,
    countClosed: (id, from, to) => countClosedTurnsFn(id, from, to),
    countFixes: (id, since, fixes) => countFixesSinceFn(id, since, fixes),
    now: () => new Date(),
    floor: FIRST_READING_FLOOR,
    ...overrides,
  };
  try {
    const latest = await deps.latestRun(projectId);
    if (!awaitsFirstReading(latest, deps.floor)) {
      return latest ? await enqueueFixedReading(projectId, latest, deps) : false;
    }
    const now = deps.now();
    const closed = await deps.countClosed(
      projectId,
      new Date(now.getTime() - FIRST_READING_LOOKBACK_MS),
      now,
    );
    if (closed < deps.floor) return false;
    return (await deps.enqueue(projectId, "first_build")) !== null;
  } catch (err) {
    logger.error({ err, project_id: projectId }, "first trace signal run enqueue failed");
    reportServerException(err, `project:${projectId}`, {
      operation: "trace_signals_first_build_enqueue",
    });
    return false;
  }
}
