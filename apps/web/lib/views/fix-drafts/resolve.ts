import { and, eq, sql } from "drizzle-orm";
import { jobs } from "@/lib/jobs/schema";
import { getDb } from "@/lib/platform/db/client";
import { changeOf, emptyChange, hasEffect } from "@/lib/views/eval-gate/change";
import { evalGateEnabledForActor } from "@/lib/views/eval-gate/gate";
import type { EvalDb } from "@/lib/views/eval-gate/runs";
import type { FixChange } from "@/lib/views/eval-gate/types";
import { draftModelAvailable } from "@/lib/views/fix-drafts/model";
import { latestFixDraft } from "@/lib/views/fix-drafts/store";
import type { Fix } from "@/lib/views/fixes/types";

type Env = Record<string, string | undefined>;

export const DRAFTING_MESSAGE =
  "The fix draft is being prepared. Try the simulation again when the draft is ready.";
export const NO_DRAFT_MODEL_MESSAGE =
  "No model key is set (ANTHROPIC_API_KEY), so this fix's text can't be drafted.";
export const DRAFT_FIX_ACTOR = "system:fix-drafts";

/** Owned (ADR-0030): the gate reads `env` (`FF_EVAL_GATE`) where upstream takes flag deps. */
export interface ResolveDraftDeps {
  db?: EvalDb;
  actor?: string;
  env?: Env;
  environment?: string;
}

/** Resolve a server-side change. The client-safe changeOf function performs no database reads. */
export async function resolveFixChange(
  projectId: string,
  fix: Fix,
  deps: ResolveDraftDeps = {},
): Promise<{ status: "ready" | "drafting" | "unsupported"; change: FixChange }> {
  const db = deps.db ?? getDb();
  const env = deps.env ?? process.env;
  const fallback = changeOf(fix);
  const enabled = await evalGateEnabledForActor(projectId, deps.actor ?? DRAFT_FIX_ACTOR, db, env);
  if (!enabled) return { status: hasEffect(fallback) ? "ready" : "unsupported", change: fallback };
  const draft = await latestFixDraft(projectId, fix.id, db);
  if (draft?.status === "ready" && hasEffect(draft.change))
    return { status: "ready", change: changeOf(fix, draft.change) };
  if (hasEffect(fallback)) return { status: "ready", change: fallback };
  if (fix.kind !== "rewrite" && fix.kind !== "tell-apart")
    return { status: "unsupported", change: fallback };
  // Owned (ADR-0030): with no model there is nothing to draft, so nothing is queued.
  if (!draftModelAvailable(env, deps.environment))
    return {
      status: "unsupported",
      change: { ...emptyChange(), unsupportedReason: NO_DRAFT_MODEL_MESSAGE },
    };
  await enqueueDraftFix(projectId, fix.id, deps.actor ?? DRAFT_FIX_ACTOR, db);
  return { status: "drafting", change: { ...emptyChange(), unsupportedReason: DRAFTING_MESSAGE } };
}

/** Coalesce requests for the same fix while its job waits or runs. The caller checks the gate. */
export async function enqueueDraftFix(
  projectId: string,
  fixId: string,
  requestedBy = DRAFT_FIX_ACTOR,
  db: EvalDb = getDb(),
): Promise<void> {
  const pending = and(
    eq(jobs.projectId, projectId),
    eq(jobs.kind, "draft_fix"),
    sql`${jobs.payload}->>'fixId' = ${fixId}`,
    sql`${jobs.status} in ('queued', 'running')`,
  );
  const [existing] = await db.select({ id: jobs.id }).from(jobs).where(pending).limit(1);
  if (existing) return;
  await db
    .insert(jobs)
    .values({ projectId, kind: "draft_fix", payload: { fixId, requestedBy } })
    .onConflictDoNothing();
}
