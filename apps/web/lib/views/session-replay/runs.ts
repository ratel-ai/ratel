import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { projects } from "@/lib/platform/projects/schema";
import { CANT_SIMULATE } from "@/lib/views/eval-gate/method";
import { DAILY_ORG_BUDGET_USD } from "@/lib/views/eval-gate/models";
import { organizationModelSpendSince, STALE_EVAL_RUN_MS } from "@/lib/views/eval-gate/store";
import { DEFAULT_K, MAX_K, type WhatIfMethod } from "@/lib/views/session-replay/fork";
import {
  defaultOrganizationFlagDeps,
  type OrganizationFlagDeps,
  sessionReplayEnabledForActor,
} from "@/lib/views/session-replay/gate";
import {
  type SessionReplayRunRow,
  sessionReplayRuns,
  sessionReplaySettings,
} from "@/lib/views/session-replay/schema";
import { type Variant, variantKey } from "@/lib/views/session-replay/variant";
// What-if's spend reader: this request's budget check counts What-if runs (owned, ADR-0030).
import "@/lib/views/session-replay/spend";

/**
 * Saved What-if runs (RC-176). `requestWhatIf` checks the flag, the project,
 * the content opt-in and the organization's daily model budget, holds the
 * run's cap under the organization's row lock, and queues a `what_if_step`
 * job. The job (`job.ts`) samples the step and saves numbers only. Runs
 * expire after 30 days; a live run that outlives the stale window times out.
 */

export const WHAT_IF_JOB = "what_if_step" as const;
/** The most one run may spend on models. */
export const WHAT_IF_RUN_CAP_USD = 0.5;
export const WHAT_IF_TTL_DAYS = 30;
/** As long as a fix simulation may run: both are one job on the same worker. */
export const STALE_WHAT_IF_MS = STALE_EVAL_RUN_MS;

const LIVE = ["queued", "running"] as const;
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WhatIfRefusal =
  | "flag_off"
  | "not_found"
  | "bad_step"
  | "content_opt_in_off"
  | "budget_spent";

const REFUSALS: Record<WhatIfRefusal, string> = {
  flag_off: "Session replay is off for this organization.",
  not_found: "No run in this project has that ID.",
  bad_step: "The step must be a model call of the run (0 or more).",
  content_opt_in_off:
    "Model replay needs the content opt-in for this project. Turn it on, or re-rank only.",
  budget_spent: "The daily model budget is spent. Try again tomorrow.",
};

export class WhatIfError extends Error {
  constructor(readonly code: WhatIfRefusal) {
    super(REFUSALS[code]);
    this.name = "WhatIfError";
  }
}

type RunsDb = ReturnType<typeof getDb>;

export interface WhatIfRequest {
  projectId: string;
  /** Who asked: a Clerk id, `project:<id>` or `system:<name>`. */
  actor: string;
  turnId: string;
  /** The model call to fork, 0-based. */
  step: number;
  variant: Variant;
  /** The row the variant came from (a fix id, a proposal id, a catalog entry, a tool name). */
  variantRef?: string | null;
  k?: number;
  /** Ask for a model replay; default: replay when the content opt-in is on, else re-rank. */
  replay?: boolean;
}

export interface RequestWhatIfDeps {
  db?: RunsDb;
  flagDeps?: OrganizationFlagDeps;
  enqueue?: (projectId: string, payload: WhatIfJobPayload) => Promise<string | null>;
  dailyBudgetUsd?: number;
  now?: () => Date;
}

export interface WhatIfJobPayload {
  runId: string;
  variant: Variant;
}

const logger = getLogger("session-replay/runs");

/** Queue a What-if run, or return the live one for the same step and variant. Throws `WhatIfError` when refused. */
export async function requestWhatIf(
  request: WhatIfRequest,
  deps: RequestWhatIfDeps = {},
): Promise<{ run: SessionReplayRunRow; created: boolean }> {
  const db = deps.db ?? getDb();
  const { projectId, actor } = request;
  if (
    !(await sessionReplayEnabledForActor(
      projectId,
      actor,
      db,
      deps.flagDeps ?? defaultOrganizationFlagDeps,
    ))
  )
    throw refuse("flag_off", request);
  const turn = UUID.test(request.turnId)
    ? (
        await db
          .select({ sessionId: traceTurns.sessionId })
          .from(traceTurns)
          .where(and(eq(traceTurns.id, request.turnId), eq(traceTurns.projectId, projectId)))
          .limit(1)
      )[0]
    : undefined;
  if (!turn) throw refuse("not_found", request);
  if (!Number.isInteger(request.step) || request.step < 0) throw refuse("bad_step", request);
  const readContent = await contentOptIn(projectId, db);
  if (request.replay && !readContent) throw refuse("content_opt_in_off", request);
  const method: WhatIfMethod = (request.replay ?? readContent) ? "replay" : "rerank";
  const k = Math.min(MAX_K, Math.max(1, Math.floor(request.k ?? DEFAULT_K)));
  const hold = method === "replay" ? WHAT_IF_RUN_CAP_USD : 0;
  const budget = deps.dailyBudgetUsd ?? DAILY_ORG_BUDGET_USD;
  const now = deps.now?.() ?? new Date();
  const key = variantKey(request.variant);

  const queued = await db.transaction(async (tx) => {
    // The organization's lock: two requests can't both fit in the last of the budget. Owned
    // (ADR-0030): an advisory lock on the organization id, since the edition owns
    // `organizations`; upstream locks its row.
    const [org] = await tx
      .select({ id: projects.organizationId })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!org) throw refuse("not_found", request);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`what_if_budget:${org.id}`}))`);
    const live = await liveRun(
      projectId,
      request.turnId,
      request.step,
      key,
      tx as unknown as RunsDb,
    );
    if (live) return { run: live, created: false };
    const spent = await organizationModelSpendSince(
      projectId,
      new Date(now.getTime() - DAY_MS),
      tx,
    );
    if (spent >= budget || spent + hold > budget) throw refuse("budget_spent", request);
    const [row] = await tx
      .insert(sessionReplayRuns)
      .values({
        projectId,
        sessionId: turn.sessionId,
        turnId: request.turnId,
        step: request.step,
        variantKind: request.variant.kind,
        variantRef: request.variantRef ?? null,
        variantKey: key,
        method,
        k,
        spend: { usd: hold, reserved: true, capUsd: WHAT_IF_RUN_CAP_USD },
        status: "queued",
        requestedBy: actor,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return { run: row, created: true };
    const raced = await liveRun(
      projectId,
      request.turnId,
      request.step,
      key,
      tx as unknown as RunsDb,
    );
    if (!raced) throw new Error("live what if run vanished after a conflicting insert");
    return { run: raced, created: false };
  });
  if (!queued.created) return queued;

  const jobId = await (deps.enqueue ?? enqueueWhatIf)(projectId, {
    runId: queued.run.id,
    variant: request.variant,
  });
  if (jobId)
    await db
      .update(sessionReplayRuns)
      .set({ jobId })
      .where(eq(sessionReplayRuns.id, queued.run.id));
  logger.info(
    {
      run_id: queued.run.id,
      project_id: projectId,
      change_kind: request.variant.kind,
      method,
      k,
      hold_usd: hold,
      outcome: "queued",
    },
    "what_if_requested",
  );
  return { run: { ...queued.run, jobId: jobId ?? queued.run.jobId }, created: true };
}

/**
 * Retention for What-if runs, on the drain: delete runs older than 30 days,
 * and fail live runs that outlived the stale window (their hold is freed;
 * what they may have spent stays counted). Each timeout logs `what_if_timed_out`.
 */
export async function pruneWhatIfRuns(
  db: RunsDb = getDb(),
  now: Date = new Date(),
): Promise<{ pruned: number; timedOut: number }> {
  const stale = new Date(now.getTime() - STALE_WHAT_IF_MS);
  const timedOut = await db
    .update(sessionReplayRuns)
    .set({
      status: "failed",
      errorCode: "timed_out",
      finishedAt: now,
      spend: sql`jsonb_set(${sessionReplayRuns.spend}, '{reserved}', 'false'::jsonb)`,
    })
    .where(
      and(
        inArray(sessionReplayRuns.status, [...LIVE]),
        lt(sql`coalesce(${sessionReplayRuns.startedAt}, ${sessionReplayRuns.createdAt})`, stale),
      ),
    )
    .returning({ id: sessionReplayRuns.id, projectId: sessionReplayRuns.projectId });
  for (const row of timedOut)
    logger.warn(
      { run_id: row.id, project_id: row.projectId, timeout_ms: STALE_WHAT_IF_MS },
      "what_if_timed_out",
    );
  const pruned = await db
    .delete(sessionReplayRuns)
    .where(lt(sessionReplayRuns.createdAt, new Date(now.getTime() - WHAT_IF_TTL_DAYS * DAY_MS)))
    .returning({ id: sessionReplayRuns.id });
  return { pruned: pruned.length, timedOut: timedOut.length };
}

/** Whether the project lets a What-if run read captured content (off unless set). */
export async function contentOptIn(projectId: string, db: RunsDb = getDb()): Promise<boolean> {
  const [row] = await db
    .select({ readContent: sessionReplaySettings.readContent })
    .from(sessionReplaySettings)
    .where(eq(sessionReplaySettings.projectId, projectId))
    .limit(1);
  return row?.readContent ?? false;
}

/** A failure reason as the code a run stores: the `CANT_SIMULATE` key, else `failed`. */
export function errorCodeOf(reason: string): string {
  const entry = Object.entries(CANT_SIMULATE).find(([, words]) => words === reason);
  return entry ? entry[0] : "failed";
}

async function liveRun(
  projectId: string,
  turnId: string,
  step: number,
  key: string,
  db: RunsDb,
): Promise<SessionReplayRunRow | null> {
  const [row] = await db
    .select()
    .from(sessionReplayRuns)
    .where(
      and(
        eq(sessionReplayRuns.projectId, projectId),
        eq(sessionReplayRuns.turnId, turnId),
        eq(sessionReplayRuns.step, step),
        eq(sessionReplayRuns.variantKey, key),
        inArray(sessionReplayRuns.status, [...LIVE]),
      ),
    )
    .limit(1);
  return row ?? null;
}

function refuse(code: WhatIfRefusal, request: WhatIfRequest): WhatIfError {
  logger.info(
    { project_id: request.projectId, change_kind: request.variant.kind, outcome: code },
    "what_if_requested",
  );
  return new WhatIfError(code);
}

async function enqueueWhatIf(projectId: string, payload: WhatIfJobPayload): Promise<string | null> {
  // Imported lazily: the route helpers pull in the drain and its handlers.
  const { enqueueForProjectId } = await import("@/lib/jobs/route-helpers");
  const result = await enqueueForProjectId(projectId, WHAT_IF_JOB, payload);
  const body = result.body as { jobId?: unknown };
  return typeof body.jobId === "string" ? body.jobId : null;
}
