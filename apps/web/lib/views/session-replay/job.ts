import { and, eq } from "drizzle-orm";
import { loadToolCorpus } from "@/lib/ingest/runtime-catalog/inventory";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import type { CorpusEntry } from "@/lib/readings/decisions/judge";
import { loadModelCalls, type ModelCall } from "@/lib/views/eval-gate/calls";
import { type EvalModels, resolveEvalModels, SpendMeter } from "@/lib/views/eval-gate/models";
import { createRanker } from "@/lib/views/eval-gate/ranker";
import { loadRuns } from "@/lib/views/eval-gate/runs";
import type { Ranker } from "@/lib/views/eval-gate/simulate";
import type { FixChange, RunRecord } from "@/lib/views/eval-gate/types";
import { type StepSample, sampleStep } from "@/lib/views/session-replay/fork";
import {
  defaultOrganizationFlagDeps,
  type OrganizationFlagDeps,
  sessionReplayEnabledForActor,
} from "@/lib/views/session-replay/gate";
import { contentOptIn, errorCodeOf } from "@/lib/views/session-replay/runs";
import { type SessionReplayRunRow, sessionReplayRuns } from "@/lib/views/session-replay/schema";
import { parseVariant } from "@/lib/views/session-replay/variant";

/**
 * The `what_if_step` job (RC-176): claim the queued run, check the flag and
 * the content opt-in again (either may have changed since it was queued),
 * sample the step inside the run's cap, and save only tool names, counts,
 * tokens and spend. A failure marks the run failed and the job completes, so
 * `what_if_finished` (status failed) is what the monitors count.
 */

type JobDb = ReturnType<typeof getDb>;

export interface WhatIfJobDeps {
  db?: JobDb;
  flagDeps?: OrganizationFlagDeps;
  models?: EvalModels;
  /** The run and its model calls; with their payloads only when content may be read. */
  loadStep?: (
    projectId: string,
    turnId: string,
    withPayload: boolean,
  ) => Promise<{ run: RunRecord; calls: ModelCall[] } | null>;
  loadCorpus?: (projectId: string) => Promise<CorpusEntry[]>;
  /** A ranker for a change; default: the project's catalog through `createRanker`. */
  rank?: (change: FixChange) => Ranker | null;
  now?: () => number;
}

export type WhatIfJobResult = { runId: string | null; status: "completed" | "failed" | "skipped" };

const logger = getLogger("session-replay/job");

export async function whatIfStepJob(
  projectId: string,
  payload: unknown,
  deps: WhatIfJobDeps = {},
): Promise<WhatIfJobResult> {
  const db = deps.db ?? getDb();
  const runId =
    payload &&
    typeof payload === "object" &&
    typeof (payload as { runId?: unknown }).runId === "string"
      ? (payload as { runId: string }).runId
      : null;
  if (!runId) return { runId: null, status: "skipped" };
  const run = await claim(projectId, runId, db);
  if (!run) return { runId, status: "skipped" };
  const now = deps.now ?? Date.now;
  const started = now();
  const variant = parseVariant((payload as { variant?: unknown }).variant);
  const spend = new SpendMeter(run.spend.capUsd);
  try {
    if (!variant) return await fail(run, "bad_variant", 0, started, now(), db);
    if (
      !(await sessionReplayEnabledForActor(
        projectId,
        run.requestedBy,
        db,
        deps.flagDeps ?? defaultOrganizationFlagDeps,
      ))
    )
      return await fail(run, "flag_off", 0, started, now(), db);
    // The opt-in may have been turned off since: then it re-ranks, without reading content.
    const withPayload = run.method === "replay" && (await contentOptIn(projectId, db));
    const step = await (deps.loadStep ?? ((p, t, w) => loadStep(p, t, w, db)))(
      projectId,
      run.turnId,
      withPayload,
    );
    if (!step) return await fail(run, "not_found", 0, started, now(), db);
    const corpus = deps.rank
      ? null
      : await (deps.loadCorpus ?? ((id) => loadToolCorpus(id, db)))(projectId);
    const sample = await sampleStep(step.run, step.calls, run.step, variant, {
      models:
        deps.models ??
        resolveEvalModels(process.env, "eval_gate_judge", undefined, "eval_gate_what_if"),
      spend,
      k: run.k,
      toolDefs: new Map(),
      rank: deps.rank ?? ((change) => createRanker(corpus ?? [], change)),
    });
    if (!sample.ok)
      return await fail(
        run,
        sample.notAffected ? "not_affected" : errorCodeOf(sample.reason),
        spend.usd,
        started,
        now(),
        db,
      );
    return await complete(run, sample, spend.usd, started, now(), db);
  } catch (err) {
    logger.error({ err, run_id: run.id, project_id: projectId }, "what if job failed");
    return fail(run, "failed", spend.usd, started, now(), db);
  }
}

async function claim(
  projectId: string,
  runId: string,
  db: JobDb,
): Promise<SessionReplayRunRow | null> {
  const [row] = await db
    .update(sessionReplayRuns)
    .set({ status: "running", startedAt: new Date() })
    .where(
      and(
        eq(sessionReplayRuns.id, runId),
        eq(sessionReplayRuns.projectId, projectId),
        eq(sessionReplayRuns.status, "queued"),
      ),
    )
    .returning();
  return row ?? null;
}

async function complete(
  run: SessionReplayRunRow,
  sample: Extract<StepSample, { ok: true }>,
  usd: number,
  started: number,
  finished: number,
  db: JobDb,
): Promise<WhatIfJobResult> {
  await db
    .update(sessionReplayRuns)
    .set({
      status: "completed",
      method: sample.method,
      k: sample.k,
      recordedTool: sample.recorded,
      beforeTool: sample.before.choice,
      afterTool: sample.after.choice,
      distribution: { before: sample.before.distribution, after: sample.after.distribution },
      tokens: {
        before: { input: sample.before.inputTokens, output: sample.before.outputTokens },
        after: { input: sample.after.inputTokens, output: sample.after.outputTokens },
      },
      spend: { usd, reserved: false, capUsd: run.spend.capUsd },
      finishedAt: new Date(),
    })
    .where(eq(sessionReplayRuns.id, run.id));
  logFinished(run, "completed", sample.method, null, usd, finished - started);
  return { runId: run.id, status: "completed" };
}

async function fail(
  run: SessionReplayRunRow,
  code: string,
  usd: number,
  started: number,
  finished: number,
  db: JobDb,
): Promise<WhatIfJobResult> {
  await db
    .update(sessionReplayRuns)
    .set({
      status: "failed",
      errorCode: code,
      spend: { usd, reserved: false, capUsd: run.spend.capUsd },
      finishedAt: new Date(),
    })
    .where(eq(sessionReplayRuns.id, run.id));
  logFinished(run, "failed", run.method, code, usd, finished - started);
  return { runId: run.id, status: "failed" };
}

function logFinished(
  run: SessionReplayRunRow,
  status: "completed" | "failed",
  method: string,
  code: string | null,
  usd: number,
  durationMs: number,
): void {
  logger.info(
    {
      run_id: run.id,
      project_id: run.projectId,
      status,
      method,
      change_kind: run.variantKind,
      k: run.k,
      cost_usd: usd,
      error_code: code,
      duration_ms: durationMs,
    },
    "what_if_finished",
  );
}

async function loadStep(
  projectId: string,
  turnId: string,
  withPayload: boolean,
  db: JobDb,
): Promise<{ run: RunRecord; calls: ModelCall[] } | null> {
  const run = (await loadRuns(projectId, [turnId], db)).get(turnId);
  if (!run) return null;
  const window = {
    turnId,
    startedAt: new Date(run.startedAt),
    endedAt: new Date(run.endedAt ?? run.startedAt),
    traceIds: run.traceIds ?? [],
  };
  const calls = await loadModelCalls(projectId, [window], { withPayload }, db);
  return { run, calls: calls.get(turnId) ?? [] };
}
