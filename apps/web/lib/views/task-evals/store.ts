import { and, asc, desc, eq, inArray, isNull, notExists, notInArray, sql } from "drizzle-orm";
import {
  type BackgroundObservability,
  createBackgroundObservability,
} from "@/lib/jobs/observability";
import { jobs } from "@/lib/jobs/schema";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { signalTitle } from "@/lib/readings/trace-signals/claims";
import { traceSignals } from "@/lib/readings/trace-signals/schema";
import { SIGNAL_KINDS } from "@/lib/readings/trace-signals/view";
import { loadAskSourcesByTurn } from "@/lib/readings/trace-signals/workflows/label-queries";
import { loadModelCalls } from "@/lib/views/eval-gate/calls";
import { evalGateEnabledForActor } from "@/lib/views/eval-gate/gate";
import { type EvalDb, loadRuns } from "@/lib/views/eval-gate/runs";
import { recordedView } from "@/lib/views/eval-gate/simulate";
import { taskEvalCases, taskEvalSets } from "@/lib/views/task-evals/schema";
import { selectTaskEvalRunsWithStats } from "@/lib/views/task-evals/selection";
import { type TaskEvalRefresh, taskEvalRow } from "@/lib/views/task-evals/view";
import { SCORER_VERSION, scoreRun } from "@/lib/views/task-scorers/engine";
import { scorersFor } from "@/lib/views/task-scorers/store";

/**
 * Owned (ADR-0030): what upstream passes to its organization flag service. Here the gate is
 * `FF_EVAL_GATE`, so the deps are the environment the gate reads; the name stays upstream's so
 * the copied callers compile unchanged.
 */
export type OrganizationFlagDeps = Record<string, string | undefined>;

export interface RefreshTaskEvalSetDeps {
  db?: EvalDb & Pick<ReturnType<typeof getDb>, "transaction">;
  flagDeps?: OrganizationFlagDeps;
  now?: () => Date;
  observability?: Pick<BackgroundObservability, "trackSystemEvent">;
  /** Scheduled jobs respect the weekly limit. Explicit requests refresh immediately. */
  scheduled?: boolean;
  actor?: string;
}

export const TASK_EVAL_REFRESH_MS = 7 * 86_400_000;
export const TASK_EVAL_ACTOR = "system:task-evals";
const logger = getLogger("task-evals/store");

/** Refresh one task atomically. Keep edited cases and retain exclusion records. */
export async function refreshTaskEvalSet(
  projectId: string,
  taskId: string,
  deps: RefreshTaskEvalSetDeps = {},
) {
  const db = deps.db ?? getDb();
  if (
    !(await evalGateEnabledForActor(projectId, deps.actor ?? TASK_EVAL_ACTOR, db, deps.flagDeps))
  ) {
    return { refreshed: false, reason: "gate_off" } as const;
  }
  const startedAt = Date.now();
  const now = deps.now?.() ?? new Date();
  const result = await db.transaction(async (tx) => {
    await tx
      .insert(taskEvalSets)
      .values({ projectId, taskId, scorerVersion: SCORER_VERSION })
      .onConflictDoNothing();
    const [set] = await tx
      .select()
      .from(taskEvalSets)
      .where(and(eq(taskEvalSets.projectId, projectId), eq(taskEvalSets.taskId, taskId)))
      .for("update");
    if (
      deps.scheduled &&
      set!.refreshedAt &&
      now.getTime() - set!.refreshedAt.getTime() < TASK_EVAL_REFRESH_MS
    ) {
      return { refreshed: false, reason: "recent" } as const;
    }
    const scope = and(eq(taskEvalCases.projectId, projectId), eq(taskEvalCases.taskId, taskId));
    const before = await tx.select().from(taskEvalCases).where(scope);
    // A rebuilt or pruned turn cannot remain an eval case, including a pinned case.
    await tx.delete(taskEvalCases).where(
      and(
        scope,
        notExists(
          tx
            .select({ id: traceTurns.id })
            .from(traceTurns)
            .where(
              and(eq(traceTurns.projectId, projectId), eq(traceTurns.id, taskEvalCases.turnId)),
            ),
        ),
      ),
    );
    const live = await tx.select().from(taskEvalCases).where(scope);
    // Fix cases do not reserve slots in the shared task set.
    const unavailable = new Set(
      live
        .filter(
          (row) =>
            row.fixId === null && (row.excludedAt !== null || row.pinned || row.origin === "user"),
        )
        .map((row) => row.turnId),
    );
    const { candidates: selected, issueCapped } = await selectTaskEvalRunsWithStats(
      {
        projectId,
        taskId,
        targetRuns: set!.targetRuns,
        exclude: unavailable,
      },
      tx,
    );
    const selectedIds = selected.map((row) => row.turnId);
    await tx
      .delete(taskEvalCases)
      .where(
        and(
          scope,
          eq(taskEvalCases.pinned, false),
          isNull(taskEvalCases.fixId),
          isNull(taskEvalCases.excludedAt),
          inArray(taskEvalCases.origin, ["auto", "issue"]),
          selectedIds.length > 0 ? notInArray(taskEvalCases.turnId, selectedIds) : undefined,
        ),
      );
    if (selected.length > 0) {
      await tx
        .insert(taskEvalCases)
        .values(selected.map((row) => ({ projectId, taskId, ...row })))
        .onConflictDoUpdate({
          target: [
            taskEvalCases.projectId,
            taskEvalCases.taskId,
            taskEvalCases.fixId,
            taskEvalCases.turnId,
          ],
          set: { origin: sql`excluded.origin`, selectionReason: sql`excluded.selection_reason` },
          setWhere: and(
            eq(taskEvalCases.pinned, false),
            inArray(taskEvalCases.origin, ["auto", "issue"]),
            isNull(taskEvalCases.excludedAt),
          ),
        });
    }
    await tx
      .update(taskEvalSets)
      .set({ scorerVersion: SCORER_VERSION, refreshedAt: now })
      .where(and(eq(taskEvalSets.projectId, projectId), eq(taskEvalSets.taskId, taskId)));
    const after = await tx.select().from(taskEvalCases).where(scope);
    const previous = new Set(before.map((row) => row.id));
    const remaining = new Set(after.map((row) => row.id));
    const active = after.filter((row) => row.excludedAt === null);
    return {
      refreshed: true,
      added: after.filter((row) => !previous.has(row.id)).length,
      kept: active.filter((row) => previous.has(row.id)).length,
      pinned: active.filter((row) => row.pinned).length,
      dropped: before.filter((row) => !remaining.has(row.id)).length,
      short_of_target: Math.max(
        0,
        set!.targetRuns -
          active.filter((row) => !row.pinned && (row.origin === "auto" || row.origin === "issue"))
            .length,
      ),
      issue_capped: issueCapped,
    } as const;
  });
  if (result.refreshed) {
    const { refreshed: _refreshed, ...counts } = result;
    const fields = {
      project_id: projectId,
      task_id: taskId,
      ...counts,
      duration_ms: Math.max(0, Date.now() - startedAt),
    };
    logger.info(fields, "task_eval_set_refreshed");
    await (deps.observability ?? createBackgroundObservability()).trackSystemEvent(
      "task_eval_set_refreshed",
      TASK_EVAL_ACTOR,
      {
        object_action: "task_eval_set_refreshed",
        ...fields,
      },
    );
  }
  return result;
}

/** Read all cases, including exclusions. The caller chooses the cases for each simulation. */
export async function taskEvalSetFor(projectId: string, taskId: string, db: EvalDb = getDb()) {
  const [set] = await db
    .select()
    .from(taskEvalSets)
    .where(and(eq(taskEvalSets.projectId, projectId), eq(taskEvalSets.taskId, taskId)));
  const cases = await db
    .select()
    .from(taskEvalCases)
    .where(and(eq(taskEvalCases.projectId, projectId), eq(taskEvalCases.taskId, taskId)))
    .orderBy(asc(taskEvalCases.turnId), asc(taskEvalCases.fixId));
  return { set: set ?? null, cases };
}

/** Read the task editor's rows from captured runs and the current enabled scorers. */
export async function taskEvalViewFor(projectId: string, taskId: string, db: EvalDb = getDb()) {
  // Read job state first so a completed job cannot stop polling before its counts are read.
  const [job] = await db
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(
      and(
        eq(jobs.projectId, projectId),
        eq(jobs.kind, "refresh_task_eval_set"),
        sql`${jobs.payload}->>'taskId' = ${taskId}`,
      ),
    )
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(1);
  const refreshJob: TaskEvalRefresh | null = job
    ? {
        id: job.id,
        status:
          job.status === "queued" || job.status === "running" || job.status === "done"
            ? job.status
            : "error",
      }
    : null;
  const { set, cases } = await taskEvalSetFor(projectId, taskId, db);
  const shared = cases.filter((row) => row.origin !== "fix");
  const scorers = (await scorersFor(projectId, taskId, db)).filter((scorer) => scorer.enabled);
  const runs = await loadRuns(
    projectId,
    shared.map((row) => row.turnId),
    db,
  );
  const calls = await loadModelCalls(
    projectId,
    [...runs.values()].map((run) => ({
      turnId: run.turnId,
      startedAt: new Date(run.startedAt),
      endedAt: new Date(run.endedAt ?? run.startedAt),
      traceIds: run.traceIds ?? [],
    })),
    { withPayload: true },
    db,
  );
  const asks = await loadAskSourcesByTurn(
    projectId,
    shared.map((row) => row.turnId),
    db,
  );
  const issueIds = [
    ...new Set(
      shared.flatMap((row) => {
        const match =
          /^Evidence of issue ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.$/i.exec(
            row.selectionReason,
          );
        return row.origin === "issue" && match ? [match[1]!] : [];
      }),
    ),
  ];
  const issues =
    issueIds.length > 0
      ? await db
          .select({ id: traceSignals.id, kind: traceSignals.kind })
          .from(traceSignals)
          .where(and(eq(traceSignals.projectId, projectId), inArray(traceSignals.id, issueIds)))
      : [];
  const byIssue = new Map(
    issues.map((issue) => {
      const kind = SIGNAL_KINDS.find((kind) => kind === issue.kind);
      return [issue.id, { id: issue.id, title: kind ? signalTitle(kind) : "Issue" }];
    }),
  );
  const expected = scorers.find((scorer) => scorer.kind === "expected_tool");
  const rows = shared.map((row) => {
    const run = runs.get(row.turnId);
    const messages = (calls.get(row.turnId) ?? []).flatMap((call) => call.payload?.messages ?? []);
    const ask = asks.get(row.turnId);
    const issueId =
      /^Evidence of issue ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.$/i.exec(
        row.selectionReason,
      )?.[1];
    return taskEvalRow({
      projectId,
      case: { ...row, origin: row.origin as "auto" | "issue" | "user" },
      messages,
      fallbackAsk: ask && ask.source !== "search" ? ask.text : null,
      results: run
        ? scoreRun(
            recordedView(run, expected?.kind === "expected_tool" ? expected.tool : null),
            scorers,
          )
        : scorers.map((scorer) => ({
            kind: scorer.kind,
            status: "skip" as const,
            score: 0,
            detail: "Run not retained",
          })),
      issue: issueId ? byIssue.get(issueId) : null,
    });
  });
  return {
    rows,
    targetRuns: set?.targetRuns ?? 20,
    refreshedAt: set?.refreshedAt?.toISOString() ?? null,
    refreshJob,
  };
}
