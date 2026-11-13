import {
  type BackgroundObservability,
  createBackgroundObservability,
} from "@/lib/jobs/observability";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";
import {
  DEFAULT_TURN_CONFIG,
  TURN_BUILD_MAX_PAGES,
  TURN_BUILD_PAGE_LIMIT,
  TURN_BUILD_SEED_WINDOW_DAYS,
  TURN_BUILD_TIME_BUDGET_MS,
  type TurnConfig,
} from "../constants";
import { traceSignalsHashSalt } from "../hash";
import type { RunTrigger } from "../run-trigger";
import { buildTurns, reloadReach } from "./build-turn";
import { normalizeEvents } from "./normalize";
import {
  type BuildJobRequest,
  closeIdleTraceTurns as closeIdleTraceTurnsFn,
  enqueueBuildTraceTurnsJob as enqueueBuildTraceTurnsJobFn,
  getTraceTurnsCursor as getTraceTurnsCursorFn,
  listProjectsDueTraceTurnBuild as listProjectsDueTraceTurnBuildFn,
  listTurnEventHits as listTurnEventHitsFn,
  listTurnEventsPage as listTurnEventsPageFn,
  loadReloadableTurns as loadReloadableTurnsFn,
  writeTurnPage as writeTurnPageFn,
} from "./queries";

/**
 * The `build_trace_turns` job: fold a project's runtime events, received after its build
 * cursor, into the durable turn ledger (`trace_turns` + `trace_turn_steps`).
 *
 * Per page of `pageLimit` events: load the stored turns the page can change (open,
 * idle-closed, named again by a declared turn id, or closed recently enough for a page
 * event to pair or dedupe against), re-derive them with the new events, and write turns,
 * steps and the advanced cursor in one transaction, so a crash mid-backlog resumes
 * exactly where it stopped. After the pages, open turns whose session went quiet are
 * closed. A backlog bigger than `maxPages` or `timeBudgetMs` continues in a freshly
 * enqueued job, so no run outlives the stale-job reaper.
 *
 * A null cursor seeds from the retention window. A cursor older than that window means
 * raw events were pruned before they were built: the job logs and tracks
 * `trace_turns_backlog_lost` and jumps to the window start rather than pretending the
 * gap is not there.
 *
 * A deployed environment without `TRACE_SIGNALS_HASH_SALT` skips the build (nothing
 * written, cursor untouched) instead of hashing under the committed development salt;
 * the backlog builds once the secret is set. Logs and events carry counts only: no query
 * text, no end-user ids.
 *
 * Owned (ADR-0030): no feature-flag gate (the Agent health gate is retired, always on),
 * and the two seams into the signal runs above (`enqueueReading`, `onBacklogDrained`)
 * are optional dependencies the readings register, not imports from L4.
 */

const logger = getLogger("ledger/build-job");
const SYSTEM_DISTINCT_ID = "system:trace-turns";
const DAY_MS = 86_400_000;

/**
 * A reporter that sends the missing-salt misconfiguration to exception tracking once per
 * process: every skipped run logs, but one report is enough to page someone, and ingest
 * can enqueue a build per request.
 */
export function createMissingSaltReporter(
  report: typeof reportServerException = reportServerException,
): (projectId: string) => void {
  let reported = false;
  return (projectId) => {
    if (reported) return;
    reported = true;
    report(new Error("TRACE_SIGNALS_HASH_SALT is not configured"), SYSTEM_DISTINCT_ID, {
      project_id: projectId,
      reason: "trace_signals_hash_salt_missing",
    });
  };
}

const reportMissingSaltOnce = createMissingSaltReporter();

export interface BuildJobDeps {
  getCursor: typeof getTraceTurnsCursorFn;
  listEvents: typeof listTurnEventsPageFn;
  listHits: typeof listTurnEventHitsFn;
  loadTurns: typeof loadReloadableTurnsFn;
  writePage: typeof writeTurnPageFn;
  closeIdle: typeof closeIdleTraceTurnsFn;
  /** The follow-up build for a backlog past this run's budget; it carries this run's request. */
  enqueueBuild: (projectId: string, request?: BuildJobRequest) => Promise<{ id: string } | null>;
  /**
   * The signal run a request asked for (`BuildJobRequest.reading`), enqueued once this
   * build has caught up: the run then reads every turn the build wrote. Coalesced with
   * one already queued. Supplied by the readings (L4); absent, a reading request is
   * acknowledged in the result as not queued.
   */
  enqueueReading?: (projectId: string, trigger: RunTrigger) => Promise<{ id: string } | null>;
  /**
   * Called once a run has caught up after building at least one page or closing an idle
   * turn: either can bring the closed-turn count to the first reading's floor. The
   * readings supply the first-signal-run enqueue here; it must never throw.
   */
  onBacklogDrained?: (projectId: string) => Promise<unknown>;
  observability: Pick<BackgroundObservability, "trackSystemEvent">;
  now: () => Date;
  /** Null in a deployed environment without a configured salt: the run skips. */
  salt: string | null;
  reportMissingSalt: (projectId: string) => void;
  config: TurnConfig;
  pageLimit: number;
  maxPages: number;
  timeBudgetMs: number;
  windowDays: number;
}

/**
 * The seams the readings fill in once they land: the job registry sets them from the
 * trace-signals registration, so the ledger never imports L4.
 */
export const ledgerSeams: Pick<BuildJobDeps, "enqueueReading" | "onBacklogDrained"> = {};

function defaultDeps(): BuildJobDeps {
  return {
    getCursor: getTraceTurnsCursorFn,
    listEvents: listTurnEventsPageFn,
    listHits: listTurnEventHitsFn,
    loadTurns: loadReloadableTurnsFn,
    writePage: writeTurnPageFn,
    closeIdle: closeIdleTraceTurnsFn,
    enqueueBuild: (projectId, request) =>
      enqueueBuildTraceTurnsJobFn(projectId, undefined, request),
    enqueueReading: ledgerSeams.enqueueReading,
    onBacklogDrained: ledgerSeams.onBacklogDrained,
    observability: createBackgroundObservability(),
    now: () => new Date(),
    salt: traceSignalsHashSalt(),
    reportMissingSalt: reportMissingSaltOnce,
    config: DEFAULT_TURN_CONFIG,
    pageLimit: TURN_BUILD_PAGE_LIMIT,
    maxPages: TURN_BUILD_MAX_PAGES,
    timeBudgetMs: TURN_BUILD_TIME_BUDGET_MS,
    windowDays: TURN_BUILD_SEED_WINDOW_DAYS,
  };
}

export type BuildJobOutcome = "built" | "caught_up" | "salt_missing";

export interface BuildJobResult {
  outcome: BuildJobOutcome;
  pages: number;
  events: number;
  turnsWritten: number;
  stepsWritten: number;
  idleClosed: number;
  /** True when this was the project's first build (null cursor). */
  firstBuild: boolean;
  /** True when the cursor had fallen behind the retention window. */
  backlogLost: boolean;
  /** True when a follow-up job was enqueued for remaining backlog. */
  continued: boolean;
  /** True when this build caught up and enqueued the signal run its request asked for. */
  readingQueued: boolean;
}

const SALT_MISSING: BuildJobResult = {
  outcome: "salt_missing",
  pages: 0,
  events: 0,
  turnsWritten: 0,
  stepsWritten: 0,
  idleClosed: 0,
  firstBuild: false,
  backlogLost: false,
  continued: false,
  readingQueued: false,
};

export async function buildProjectTraceTurns(
  projectId: string,
  overrides: Partial<BuildJobDeps> = {},
  request: BuildJobRequest = {},
): Promise<BuildJobResult> {
  const deps = { ...defaultDeps(), ...overrides };
  const startedAt = deps.now();

  const salt = deps.salt;
  if (salt === null) {
    logger.error({ project_id: projectId }, "trace turns build skipped without hash salt");
    deps.reportMissingSalt(projectId);
    return SALT_MISSING;
  }

  const start = await resolveStart(projectId, deps, startedAt);
  let since = start.since;
  let pages = 0;
  let events = 0;
  let turnsWritten = 0;
  let stepsWritten = 0;
  let caughtUp = false;

  while (pages < deps.maxPages && deps.now().getTime() - startedAt.getTime() < deps.timeBudgetMs) {
    const rows = await deps.listEvents(projectId, since, undefined, deps.pageLimit);
    if (rows.length === 0) {
      caughtUp = true;
      break;
    }
    pages += 1;
    events += rows.length;

    const searchIds = rows
      .filter((r) => r.type === "search" || r.type === "skill_search")
      .map((r) => r.id);
    const hits = await deps.listHits(searchIds);
    const normalized = normalizeEvents(rows, hits, { salt });
    const sessionIds = [...new Set(normalized.map((e) => e.sessionId))];
    const declaredKeys = [
      ...new Set(
        normalized.flatMap((e) => (e.declaredTurnId ? [`declared:${e.declaredTurnId}`] : [])),
      ),
    ];
    const reach = reloadReach(normalized, deps.config);
    const stored = await deps.loadTurns(projectId, sessionIds, declaredKeys, reach);
    const now = deps.now();
    const built = buildTurns({ stored, events: normalized, now, config: deps.config });

    const last = rows[rows.length - 1];
    if (!last) break;
    const written = await deps.writePage({
      projectId,
      turns: built.turns,
      orphanedTurnIds: built.orphanedTurnIds,
      through: last.receivedAtRaw,
      now,
    });
    turnsWritten += written.turnsWritten;
    stepsWritten += written.stepsWritten;
    since = last.receivedAtRaw;

    if (rows.length < deps.pageLimit) {
      caughtUp = true;
      break;
    }
  }

  const finishedAt = deps.now();
  const idleClosed = await deps.closeIdle(
    projectId,
    new Date(finishedAt.getTime() - deps.config.idleCloseMs),
    finishedAt,
  );
  // A backlog past this run's budget continues in a fresh job, and a reading asked of
  // this one waits for that job rather than reading half a backlog.
  const continued = !caughtUp && (await deps.enqueueBuild(projectId, request)) !== null;
  // Idle close is how most turns of a quiet project close, so a run that only closed
  // turns can be the one that reaches the first reading's floor.
  if (caughtUp && (pages > 0 || idleClosed > 0)) await deps.onBacklogDrained?.(projectId);
  const readingQueued =
    caughtUp && request.reading && deps.enqueueReading
      ? (await deps.enqueueReading(projectId, request.reading)) !== null
      : false;

  const result: BuildJobResult = {
    outcome: pages === 0 ? "caught_up" : "built",
    pages,
    events,
    turnsWritten,
    stepsWritten,
    idleClosed,
    firstBuild: start.firstBuild,
    backlogLost: start.backlogLost,
    continued,
    readingQueued,
  };
  await report(projectId, result, Math.max(0, deps.now().getTime() - startedAt.getTime()), deps);
  return result;
}

/** Where this run reads from: the cursor, the seed window on a first build, or the
 * window start when the cursor fell behind the prune. */
async function resolveStart(
  projectId: string,
  deps: BuildJobDeps,
  now: Date,
): Promise<{ since: Date | string; firstBuild: boolean; backlogLost: boolean }> {
  const windowStart = new Date(now.getTime() - deps.windowDays * DAY_MS);
  const cursor = await deps.getCursor(projectId);
  if (cursor === null) return { since: windowStart, firstBuild: true, backlogLost: false };
  if (cursor.at.getTime() >= windowStart.getTime()) {
    return { since: cursor.raw, firstBuild: false, backlogLost: false };
  }
  const lagMs = windowStart.getTime() - cursor.at.getTime();
  logger.warn(
    {
      project_id: projectId,
      cursor: cursor.raw,
      window_start: windowStart.toISOString(),
      lag_ms: lagMs,
    },
    "trace turns backlog lost to retention",
  );
  await deps.observability.trackSystemEvent("trace_turns_backlog_lost", SYSTEM_DISTINCT_ID, {
    object_action: "trace_turns_backlog_lost",
    project_id: projectId,
    lag_ms: lagMs,
  });
  return { since: windowStart, firstBuild: false, backlogLost: true };
}

async function report(
  projectId: string,
  result: BuildJobResult,
  durationMs: number,
  deps: BuildJobDeps,
): Promise<void> {
  const fields = {
    project_id: projectId,
    outcome: result.outcome,
    pages: result.pages,
    events: result.events,
    turns_written: result.turnsWritten,
    steps_written: result.stepsWritten,
    idle_closed: result.idleClosed,
    first_build: result.firstBuild,
    backlog_lost: result.backlogLost,
    continued: result.continued,
    reading_queued: result.readingQueued,
    duration_ms: durationMs,
  };
  logger.info(fields, "trace turns build completed");
  await deps.observability.trackSystemEvent("trace_turns_built", SYSTEM_DISTINCT_ID, {
    object_action: "trace_turns_built",
    ...fields,
  });
}

export interface DueBuildDeps {
  enqueueBuild: typeof enqueueBuildTraceTurnsJobFn;
  listDueProjects: typeof listProjectsDueTraceTurnBuildFn;
}

/**
 * The cron drain's safety net: enqueue a build for every project with unbuilt events or
 * idle open turns and no queued build. Normal traffic never needs this; it recovers a
 * post-response kick that was lost and closes turns of projects that stopped sending.
 */
export async function enqueueDueTraceTurnBuilds(
  overrides: Partial<DueBuildDeps> = {},
): Promise<{ enqueued: number }> {
  const deps: DueBuildDeps = {
    enqueueBuild: enqueueBuildTraceTurnsJobFn,
    listDueProjects: listProjectsDueTraceTurnBuildFn,
    ...overrides,
  };
  const candidates = await deps.listDueProjects();
  let enqueued = 0;
  for (const { id } of candidates) {
    if ((await deps.enqueueBuild(id)) !== null) enqueued += 1;
  }
  return { enqueued };
}
