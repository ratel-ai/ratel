import { and, eq, inArray } from "drizzle-orm";
import { jobs } from "@/lib/jobs/schema";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import {
  defaultOrganizationFlagDeps,
  type OrganizationFlagDeps,
} from "@/lib/platform/organization-flags";
import { evalRuns } from "@/lib/views/evals/schema";
import { createDrizzleEvalStore } from "./adapters/drizzle-store";
import { type EvalRun, IN_SET_STATUSES } from "./domain/types";
import { EVALS_OFF_ERROR, evalsEnabledForActor } from "./gate";

/**
 * RC-289: queue a manual run of the eval set (every eval, or those of
 * one task). The run row and its `run_eval_set` job commit together; a second
 * click while a manual run is live gets that run back.
 */

export const RUN_EVAL_SET_JOB = "run_eval_set" as const;

export interface RunEvalSetPayload {
  runId: string;
  /** Only the evals linked to this task; absent means all evals. */
  workflowId?: string;
  /** RC-297: only this eval ("Save and run"), whatever its review status unless archived. */
  evalId?: string;
}

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface RequestEvalRunDeps {
  db?: ReturnType<typeof getDb>;
  flagDeps?: OrganizationFlagDeps;
  getSession: () => Promise<{ user: { id: string; externalId: string } } | null>;
  findProjectScope: (
    projectId: string,
    userId: string,
  ) => Promise<{ project: { id: string }; organization: { id: string } } | null>;
  track?: (event: {
    externalId: string;
    projectId: string;
    organizationId: string;
    runId: string;
    evalCount: number;
    workflowId: string | null;
  }) => Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const logger = getLogger("evals/run");

/** The server action's work: the caller must be a member and have `cloud-eval-gate` on. */
export async function requestEvalRun(
  projectId: string,
  workflowId: string | null,
  deps: RequestEvalRunDeps,
): Promise<ActionResult<EvalRun>> {
  const session = await deps.getSession();
  if (!session) return { ok: false, error: "Sign in to run evals." };
  const scope = UUID.test(projectId)
    ? await deps.findProjectScope(projectId, session.user.id)
    : null;
  if (!scope) return { ok: false, error: "No project you belong to has that ID." };
  const actor = session.user.externalId;
  const db = deps.db ?? getDb();
  if (
    !(await evalsEnabledForActor(
      scope.project.id,
      actor,
      db,
      deps.flagDeps ?? defaultOrganizationFlagDeps,
    ))
  ) {
    return { ok: false, error: EVALS_OFF_ERROR };
  }
  const queued = await queueEvalRun(scope.project.id, actor, workflowId, db);
  if (!queued.ok) return queued;
  const { run, created } = queued.value;
  if (created) {
    logger.info(
      {
        project_id: run.projectId,
        run_id: run.id,
        eval_count: run.evalCount,
        workflow_id: workflowId,
        actor,
      },
      "eval_run_queued",
    );
    await deps.track?.({
      externalId: actor,
      projectId: run.projectId,
      organizationId: scope.organization.id,
      runId: run.id,
      evalCount: run.evalCount,
      workflowId,
    });
  }
  return { ok: true, value: run };
}

/** Insert the run and its job in one transaction, or return the live manual run. A nightly run is never coalesced: its sweep decides when one is due. */
export async function queueEvalRun(
  projectId: string,
  actor: string,
  workflowId: string | null,
  db: ReturnType<typeof getDb> = getDb(),
  kind: "manual" | "nightly" = "manual",
  createdAt?: Date,
  only: { id: string; name: string } | null = null,
): Promise<ActionResult<{ run: EvalRun; created: boolean }>> {
  const evals = only
    ? [only]
    : await createDrizzleEvalStore(db).listEvals(projectId, {
        statuses: IN_SET_STATUSES,
        ...(workflowId ? { workflowId } : {}),
      });
  if (evals.length === 0) return { ok: false, error: "There are no evals to run." };
  return db.transaction(async (tx) => {
    const store = createDrizzleEvalStore(tx as unknown as ReturnType<typeof getDb>);
    const [live] =
      kind === "nightly"
        ? []
        : await tx
            .select({ id: evalRuns.id })
            .from(evalRuns)
            .where(
              and(
                eq(evalRuns.projectId, projectId),
                eq(evalRuns.kind, "manual"),
                inArray(evalRuns.status, ["queued", "running"]),
              ),
            )
            .limit(1)
            .for("update");
    if (live)
      return {
        ok: true as const,
        value: { run: (await store.getRun(projectId, live.id))!, created: false },
      };
    const suite = only ? `Eval ${only.name}` : workflowId ? `Task ${workflowId}` : "All evals";
    const run = await store.createRun({
      projectId,
      kind,
      createdBy: actor,
      suite,
      evalCount: evals.length,
      createdAt,
    });
    const payload: RunEvalSetPayload = {
      runId: run.id,
      ...(workflowId ? { workflowId } : {}),
      ...(only ? { evalId: only.id } : {}),
    };
    await tx.insert(jobs).values({ projectId, kind: RUN_EVAL_SET_JOB, payload: { ...payload } });
    return { ok: true as const, value: { run, created: true } };
  });
}

export function parseRunEvalSetPayload(payload: unknown): RunEvalSetPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const { runId, workflowId, evalId } = payload as Record<string, unknown>;
  if (typeof runId !== "string" || !UUID.test(runId)) return null;
  return {
    runId,
    ...(typeof workflowId === "string" && workflowId ? { workflowId } : {}),
    ...(typeof evalId === "string" && UUID.test(evalId) ? { evalId } : {}),
  };
}
