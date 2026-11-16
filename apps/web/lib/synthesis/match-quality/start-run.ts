import { type EnqueueResult, enqueueForProjectId } from "@/lib/jobs/route-helpers";
import {
  checkMeteredFeature,
  type FeatureAccess,
  type OrgLimitView,
} from "@/lib/platform/entitlements";
import { getLogger } from "@/lib/platform/logger";
import { JUDGE_BUDGET_USD } from "@/lib/synthesis/match-quality/judge";
import type { MatchQualityRunRow } from "@/lib/synthesis/match-quality/schema";
import { countRunsSince, type StartRunInput, startRun } from "./queries";
import { resolveEvidenceSource } from "./search-source";
import {
  isRunWindowSupported,
  parseRunWindowDays,
  resolveRunWindow,
  startOfBillingPeriod,
} from "./window";

/**
 * Starting a manual match quality run: the plan budget, the evidence source,
 * the single live-run slot and the queued job. Shared by the console's run
 * action and the MCP `run_quality_analysis` tool, so a run started from either
 * passes the same checks and is metered the same way.
 *
 * The caller has already authorized the project. Events and cache revalidation
 * stay with the caller, which knows its surface.
 */

const logger = getLogger("match-quality/start-run");

export interface ManualRunDeps {
  countRunsSince: (projectId: string, since: Date) => Promise<number>;
  resolveEvidenceSource: (
    projectId: string,
    window: { since: Date; until: Date },
  ) => Promise<{ experimentName: string; count: number } | null>;
  startRun: (input: StartRunInput, now: Date) => Promise<MatchQualityRunRow | null>;
  enqueue: (
    projectId: string,
    kind: "match_quality_run",
    payload: unknown,
  ) => Promise<EnqueueResult>;
  now?: () => Date;
}

export const defaultManualRunDeps: ManualRunDeps = {
  countRunsSince: (projectId, since) => countRunsSince(projectId, since),
  resolveEvidenceSource: (projectId, window) => resolveEvidenceSource(projectId, window),
  startRun: (input, now) => startRun(input, undefined, now),
  enqueue: (projectId, kind, payload) => enqueueForProjectId(projectId, kind, payload),
};

export type ManualRunOutcome =
  | { ok: false; reason: "window_unsupported" | "no_source" | "enqueue_failed"; message: string }
  /** The plan refused: not on it, or this period's runs are spent. */
  | { ok: false; reason: "quota"; message: string; access: Exclude<FeatureAccess, { ok: true }> }
  /** A run is already queued or running; a double click, not a failure. */
  | { ok: true; status: "already_running"; message: string; windowDays: number }
  | {
      ok: true;
      status: "started";
      run: MatchQualityRunRow;
      jobId: string | null;
      windowDays: number;
      /** The plan check before this run, so the caller can say what is left. */
      access: Extract<FeatureAccess, { ok: true }>;
    };

export interface ManualRunInput {
  project: { id: string; name: string };
  organization: OrgLimitView;
  windowDaysRaw: number;
}

export async function startManualRun(
  input: ManualRunInput,
  deps: ManualRunDeps = defaultManualRunDeps,
): Promise<ManualRunOutcome> {
  const { project, organization } = input;
  const windowDays = parseRunWindowDays(input.windowDaysRaw);
  if (!isRunWindowSupported(windowDays)) {
    return {
      ok: false,
      reason: "window_unsupported",
      message: "That window is longer than the telemetry we keep.",
    };
  }

  const now = deps.now?.() ?? new Date();
  const used = await deps.countRunsSince(project.id, startOfBillingPeriod(now));
  const access = checkMeteredFeature(
    organization,
    "matchQualityRunsPerMonth",
    used,
    "Match quality",
  );
  if (!access.ok) return { ok: false, reason: "quota", message: access.message, access };

  const window = resolveRunWindow(windowDays, now);
  // A calibration when there is one, plain search telemetry otherwise.
  const source = await deps.resolveEvidenceSource(project.id, window);
  if (!source) {
    return {
      ok: false,
      reason: "no_source",
      message:
        "No searches with their query text were recorded in this window, so there is nothing to analyse.",
    };
  }

  const run = await deps.startRun(
    {
      projectId: project.id,
      experimentName: source.experimentName,
      trigger: "manual",
      windowDays,
      windowStart: window.since,
      windowEnd: window.until,
    },
    now,
  );
  // Null means the partial unique index refused: a run is already live. That is
  // the correct answer to a double click, not an error to surface as a failure.
  if (!run)
    return {
      ok: true,
      status: "already_running",
      message: "A run is already in progress.",
      windowDays,
    };

  // The already-authorized variant: the caller resolved and checked the project
  // itself, so re-resolving it from a slug would both duplicate the work and
  // disagree with the scope it authorized against. It also schedules the
  // post-response drain, so a manual run starts now rather than on the next
  // cron tick.
  const enqueued = await deps.enqueue(project.id, "match_quality_run", {
    runId: run.id,
    projectId: project.id,
    projectName: project.name,
    experimentName: source.experimentName,
    windowStart: window.since.toISOString(),
    windowEnd: window.until.toISOString(),
    // The caller proved access to match quality for this project, and the
    // judge shares that gate.
    judge: true,
    // Same gate again: the backtest rides on it for the same reason the judge does.
    backtest: true,
    // Someone asked for it: judge the new requests since the last sweep, not
    // the whole window. The weekly sweep has the bigger budget.
    judgeBudgetUsd: JUDGE_BUDGET_USD.manual,
  });
  if (enqueued.status >= 400) {
    logger.error(
      { project_id: project.id, status: enqueued.status },
      "match quality run enqueue rejected",
    );
    return { ok: false, reason: "enqueue_failed", message: "Could not queue the run." };
  }

  return { ok: true, status: "started", run, jobId: jobIdOf(enqueued), windowDays, access };
}

function jobIdOf(result: EnqueueResult): string | null {
  const body = result.body as { jobId?: unknown } | null;
  return body && typeof body.jobId === "string" ? body.jobId : null;
}
