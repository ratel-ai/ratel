import {
  createBackgroundObservability,
  defaultBackgroundObservabilityDeps,
} from "@/lib/jobs/observability";
import { getLogger } from "@/lib/platform/logger";
import type { JudgeEngine } from "@/lib/readings/decisions/judge";
import { JUDGE_BUDGET_USD } from "@/lib/synthesis/match-quality/judge";
import { loadCorpusWithFingerprint } from "@/lib/synthesis/match-quality/service";
import { type AnalystDeps, anthropicAnalystDeps, DEFAULT_ANALYST_MODEL } from "./analyst";
import type { AnalystContext } from "./context";
import { loadInvokedToolsBySearchId, observeRetrieval } from "./evidence";
import { resolveJudgeEngine } from "./judges";
import { mockAnalystDeps, mockAnalystEnabled, mockJudgeEngine } from "./mock";
import { type PersistInput, type RunDeps, runMatchQuality } from "./pipeline";
import {
  failRun,
  loadLabels,
  loadReplayHistory,
  markRunRunning,
  persistFinishedRun,
} from "./queries";
import { loadSourceSelections } from "./search-source";

/**
 * Wiring one queued `match_quality_run` to the real collaborators.
 *
 * The analyst is chosen here and nowhere else, which is what keeps the three ways
 * a run can end distinguishable to a reader of the stored row:
 *
 *   mock enabled     -> a deterministic local stand-in, stored `mocked = true`
 *   API key present  -> the real model, stored with its name
 *   neither          -> the dep is OMITTED, and the pipeline still gathers, freezes
 *                       and stores every bit of evidence while reporting that
 *                       nothing was drafted from it
 *
 * The third is the same degradation `lib/jobs/handlers.ts` already uses for the
 * skill generators, and it is why a checkout with no key shows a working, honest
 * surface rather than a stack trace.
 */

const logger = getLogger("match-quality/job");

export interface MatchQualityJobPayload {
  runId: string;
  projectId: string;
  projectName: string;
  experimentName: string;
  /** ISO strings: a job payload is JSON, so the window cannot travel as Dates. */
  windowStart: string;
  windowEnd: string;
  /**
   * Whether the judge may run for this project.
   *
   * Resolved where the job is ENQUEUED, because that is where the organization
   * is already loaded for the parent flag, and a job should not re-evaluate a
   * flag that could have flipped while it sat in the queue. Optional so a job
   * queued before this shipped still parses, and falls back to no judging.
   */
  judge?: boolean;
  /**
   * Whether this run may replay the history and write to the answer key.
   *
   * Resolved at ENQUEUE time for the same reason `judge` is: that is where the
   * organization is already loaded, and a job should not re-evaluate a flag that
   * could have flipped while it sat in the queue. Optional so a job queued before
   * this shipped still parses, and falls back to the phase-1 behaviour exactly —
   * no replay, no key write, and a `preview` that still says what it always did.
   */
  backtest?: boolean;
  /**
   * Dollars this run may spend on judging: `JUDGE_BUDGET_USD.scheduled` from the
   * weekly sweep, `.manual` from the button. Optional so a job queued before this
   * shipped still parses, and it then gets the manual (smaller) budget.
   */
  judgeBudgetUsd?: number;
}

export function parseMatchQualityPayload(raw: unknown): MatchQualityJobPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const fields = [
    "runId",
    "projectId",
    "projectName",
    "experimentName",
    "windowStart",
    "windowEnd",
  ] as const;
  for (const field of fields) {
    if (typeof record[field] !== "string" || record[field] === "") return null;
  }
  const payload = record as unknown as MatchQualityJobPayload;
  if (Number.isNaN(Date.parse(payload.windowStart))) return null;
  if (Number.isNaN(Date.parse(payload.windowEnd))) return null;
  return payload;
}

/**
 * Pick the analyst factory for this deployment.
 *
 * The mock is checked FIRST. A laptop that happens to have a real key in its
 * environment should still honour an explicit request not to spend it, and the
 * mock's own allowlist already refuses to answer anywhere that is not local, so
 * checking it first cannot leak into a real account.
 */
/**
 * Pick the judge engine for this deployment.
 *
 * Off unless the enqueuer said so, and the mock is checked first for the same
 * reason the analyst's is. With no engine configured it stays off rather than
 * throwing: a deployment without a key already degrades to gathering evidence,
 * and the judge should not be the thing that turns that into a failure.
 */
export function resolveJudge(
  enabled: boolean,
  budgetUsd: number = JUDGE_BUDGET_USD.manual,
): JudgeEngine | undefined {
  if (!enabled) return undefined;
  if (mockAnalystEnabled()) return mockJudgeEngine();
  return resolveJudgeEngine(process.env, { budgetUsd });
}

export function resolveAnalystFactory(): {
  analyst: ((context: AnalystContext) => AnalystDeps) | undefined;
  mocked: boolean;
} {
  if (mockAnalystEnabled()) {
    return { analyst: (context) => mockAnalystDeps(context), mocked: true };
  }
  if (!process.env.ANTHROPIC_API_KEY) return { analyst: undefined, mocked: false };
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_ANALYST_MODEL;
  return { analyst: () => anthropicAnalystDeps(model), mocked: false };
}

/** Persist one finished run: freeze its evidence, replace its proposals, close it. */
export async function persistRun(
  runId: string,
  projectId: string,
  input: PersistInput,
): Promise<void> {
  await persistFinishedRun(runId, projectId, input.items, input.proposals, {
    census: input.census,
    scores: input.scores,
    observedStages: input.observedStages,
    followThrough: input.followThrough,
    corpusFingerprint: input.corpusFingerprint,
    model: input.model,
    mocked: input.mocked,
    diagnosis: input.diagnosis,
    diagnosisPoints: input.diagnosisPoints,
    declinedReason: input.declinedReason,
    scorer: input.scorer,
    judge: input.judge,
    backtest: input.backtest,
    labels: input.labels,
  });
}

/** The production collaborators, with the analyst left to the caller. */
export function matchQualityRunDeps(
  analyst: ((context: AnalystContext) => AnalystDeps) | undefined,
  persist: (input: PersistInput) => Promise<void>,
  judge?: JudgeEngine,
  backtest = false,
): RunDeps {
  return {
    // A calibration's comparisons, or plain search telemetry when the run was
    // started without one (`SEARCH_TELEMETRY_SOURCE`).
    loadSelections: (projectId, experimentName, window) =>
      loadSourceSelections(projectId, experimentName, window),
    loadInvokedBySearchId: (projectId, searchIds, window) =>
      loadInvokedToolsBySearchId(projectId, searchIds, window),
    observeRetrieval: (projectId, window) => observeRetrieval(projectId, window),
    loadCorpus: (projectId) => loadCorpusWithFingerprint(projectId),
    // Both omitted when the flag is off, which is what makes the gate total: with
    // no key the judge samples exactly as it did before and nothing is written
    // back, and with no history there is no replay to store. The surface then has
    // no backtest to render, so the page needs no second gate of its own.
    ...(backtest
      ? {
          loadLabels: (projectId: string) => loadLabels(projectId),
          loadHistory: (projectId: string) => loadReplayHistory(projectId),
        }
      : {}),
    analyst,
    judge,
    persist,
  };
}

export interface MatchQualityJobResult {
  proposalsCreated: number;
  declined: boolean;
  usedModel: boolean;
  mocked: boolean;
}

/** Execute one queued run to completion. */
export async function executeMatchQualityRun(
  payload: MatchQualityJobPayload,
): Promise<MatchQualityJobResult> {
  const { runId, projectId } = payload;
  const { analyst, mocked } = resolveAnalystFactory();
  // A run is a background business mutation, so its outcome is a typed event on
  // `project:<id>`, per the observability contract in AGENTS.md. Declining is a
  // distinct outcome from failing and from completing: a dashboard that folded
  // them together could not tell "the telemetry was too thin" from "the model
  // call broke", which is the first thing an operator needs to know.
  const observability = createBackgroundObservability(defaultBackgroundObservabilityDeps);
  await markRunRunning(runId);

  try {
    const outcome = await runMatchQuality(
      {
        projectId,
        projectName: payload.projectName,
        experimentName: payload.experimentName,
        window: {
          since: new Date(payload.windowStart),
          until: new Date(payload.windowEnd),
        },
        mocked,
      },
      matchQualityRunDeps(
        analyst,
        (input) => persistRun(runId, projectId, input),
        resolveJudge(
          payload.judge === true,
          typeof payload.judgeBudgetUsd === "number" && payload.judgeBudgetUsd >= 0
            ? payload.judgeBudgetUsd
            : JUDGE_BUDGET_USD.manual,
        ),
        payload.backtest === true,
      ),
    );

    logger.info(
      {
        project_id: projectId,
        run_id: runId,
        proposals: outcome.proposalsCreated,
        candidates: outcome.candidatesFound,
        declined: outcome.declinedReason !== null,
        mocked,
      },
      "match quality run finished",
    );

    const declined = outcome.declinedReason !== null;
    await observability.trackProjectEvent(
      declined ? "match_quality_run_declined" : "match_quality_run_completed",
      projectId,
      {
        run_id: runId,
        window_days: Math.round(
          (new Date(payload.windowEnd).getTime() - new Date(payload.windowStart).getTime()) /
            (24 * 60 * 60 * 1000),
        ),
        searches_scored: outcome.census.selectionsEvaluated,
        revealed_n: outcome.census.revealedN,
        reference_n: outcome.census.referenceN,
        judged_n: outcome.census.judgedN,
        judge_changed: outcome.judge?.changed ?? 0,
        judge_abstained: outcome.judge?.abstained ?? 0,
        reference_accuracy: outcome.judge?.referenceAccuracy ?? null,
        attribution_mode: outcome.census.attributionMode,
        candidates: outcome.candidatesFound,
        proposals: outcome.proposalsCreated,
        rejected_entry_ids: outcome.rejectedEntryIds.length,
        used_model: outcome.usedModel,
        labels_written: outcome.labelsWritten,
        backtest_n: outcome.backtest?.n ?? null,
        backtest_quality_delta: outcome.backtest?.delta.quality ?? null,
        backtest_significant: outcome.backtest?.delta.significant ?? null,
        mocked,
      },
    );

    return {
      proposalsCreated: outcome.proposalsCreated,
      declined,
      usedModel: outcome.usedModel,
      mocked,
    };
  } catch (error) {
    // The run row is the only record a reader has; leaving it `running` forever
    // would read as a hung job rather than a failed one. The job runner still
    // marks the job itself errored and rethrows.
    await failRun(runId, error instanceof Error ? error.message : String(error));
    await observability.trackProjectEvent("match_quality_run_failed", projectId, {
      run_id: runId,
      mocked,
    });
    throw error;
  }
}
