import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { jobs } from "@/lib/jobs/schema";
import { getDb } from "@/lib/platform/db/client";
import { loadAskSourcesByTurn } from "@/lib/readings/trace-signals/workflows/label-queries";
import { changeOf } from "@/lib/views/eval-gate/change";
import { parseExpected } from "@/lib/views/eval-gate/defaults";
import type { EvalDb } from "@/lib/views/eval-gate/runs";
import { latestFixDraft } from "@/lib/views/fix-drafts/store";
import type { Fix } from "@/lib/views/fixes/types";
import { type TaskEvalRunRow, taskEvalRuns } from "@/lib/views/task-evals/schema";
import { scorersFor } from "@/lib/views/task-scorers/store";
import { taskShipmentsFor } from "./post-ship";
import { simulationInputKey, taskReplayRuns, taskSimulationState } from "./simulation-view";
import { taskEvalSetFor, taskEvalViewFor } from "./store";

export type TaskSimulationDetail = Awaited<ReturnType<typeof taskSimulationDetailFor>>;
export type TaskSimulationListRow = Awaited<ReturnType<typeof taskSimulationListFor>>[number];

/** Read the draft, cases and run snapshots for one task and fix. Callers check access. */
export async function taskSimulationDetailFor(
  projectId: string,
  taskId: string,
  fix: Fix,
  db: EvalDb = getDb(),
) {
  const [inputs, runs, taskSet, shipments] = await Promise.all([
    inputsFor(projectId, taskId, fix, db),
    db
      .select()
      .from(taskEvalRuns)
      .where(
        and(
          eq(taskEvalRuns.projectId, projectId),
          eq(taskEvalRuns.taskId, taskId),
          eq(taskEvalRuns.fixId, fix.id),
          eq(taskEvalRuns.kind, "simulation"),
        ),
      )
      .orderBy(desc(taskEvalRuns.createdAt), desc(taskEvalRuns.id))
      .limit(30),
    taskEvalViewFor(projectId, taskId, db),
    taskShipmentsFor(projectId, taskId, db),
  ]);
  const fixCases = inputs.cases.filter((item) => item.fixId === fix.id && item.excludedAt === null);
  const asks = await loadAskSourcesByTurn(
    projectId,
    fixCases.map((item) => item.turnId),
    db,
  );
  return {
    shipments: shipments.filter((shipment) => shipment.fixId === fix.id),
    projectId,
    taskId,
    fixId: fix.id,
    title: fix.title,
    change: inputs.change,
    draftStatus: inputs.draftStatus,
    tools: fix.subject.tools.map((tool) => ({ id: tool.id, label: tool.label })),
    state: taskSimulationState(runs[0] ?? null, inputs.key),
    replayRuns: taskReplayRuns(runs[0] ?? null, projectId),
    taskCases: taskSet.rows.filter((row) => !row.excluded),
    fixCases: fixCases.map((item) => ({
      id: item.id,
      turnId: item.turnId,
      ask: asks.get(item.turnId)?.text ?? "Ask not captured",
      expected: parseExpected(item.expected),
      criteria: item.criteria,
      runHref: `/project/${encodeURIComponent(projectId)}/traces/turns/${encodeURIComponent(item.turnId)}`,
    })),
    runs: runs.map((run) => ({
      id: run.id,
      createdAt: run.createdAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      status: run.status,
      ...taskSimulationState(run, inputs.key),
      error: run.error,
      caseCount: run.caseCount,
      fixCaseCount: run.fixCaseCount,
      breakdown: run.breakdown,
    })),
  };
}

/** Each task fix uses its latest simulation, never a post-shipment measurement. */
export async function taskSimulationListFor(
  projectId: string,
  taskId: string,
  fixes: readonly Fix[],
  db: EvalDb = getDb(),
) {
  const taskFixes = fixes.filter((fix) => fix.subject.tasks.some((task) => task.id === taskId));
  if (taskFixes.length === 0) return [];
  const taskInputs = await taskInputsFor(projectId, taskId, db);
  const runs = await db
    .selectDistinctOn([taskEvalRuns.fixId])
    .from(taskEvalRuns)
    .where(
      and(
        eq(taskEvalRuns.projectId, projectId),
        eq(taskEvalRuns.taskId, taskId),
        eq(taskEvalRuns.kind, "simulation"),
      ),
    )
    .orderBy(taskEvalRuns.fixId, desc(taskEvalRuns.createdAt), desc(taskEvalRuns.id));
  const byFix = new Map<string, TaskEvalRunRow>(runs.map((run) => [run.fixId, run]));
  return Promise.all(
    taskFixes.map(async (fix) => {
      const inputs = await inputsFor(projectId, taskId, fix, db, taskInputs);
      const run = byFix.get(fix.id) ?? null;
      return {
        fixId: fix.id,
        title: fix.title,
        why: fix.why,
        ...taskSimulationState(run, inputs.key),
        drafting: inputs.draftStatus === "drafting",
        createdAt: run?.createdAt.toISOString() ?? null,
      };
    }),
  );
}

async function inputsFor(
  projectId: string,
  taskId: string,
  fix: Fix,
  db: EvalDb,
  shared?: Awaited<ReturnType<typeof taskInputsFor>>,
) {
  const [draft, taskInputs] = await Promise.all([
    latestFixDraft(projectId, fix.id, db),
    shared ?? taskInputsFor(projectId, taskId, db),
  ]);
  const change = changeOf(fix, draft?.status === "ready" ? draft.change : null);
  const [pendingDraft] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.projectId, projectId),
        eq(jobs.kind, "draft_fix"),
        sql`${jobs.payload}->>'fixId' = ${fix.id}`,
        inArray(jobs.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  if (change.unsupportedReason && (fix.kind === "rewrite" || fix.kind === "tell-apart")) {
    change.unsupportedReason = pendingDraft
      ? "The draft is being prepared."
      : "Run the simulation to prepare this fix's draft.";
  }
  const cases = taskInputs.cases.filter((item) => item.fixId === null || item.fixId === fix.id);
  return {
    draft,
    draftStatus: pendingDraft && draft?.status !== "ready" ? "drafting" : (draft?.status ?? null),
    change,
    cases,
    key: simulationInputKey(change, cases, taskInputs.scorers),
  };
}

async function taskInputsFor(projectId: string, taskId: string, db: EvalDb) {
  const [set, scorers] = await Promise.all([
    taskEvalSetFor(projectId, taskId, db),
    scorersFor(projectId, taskId, db),
  ]);
  return { cases: set.cases, scorers: scorers.filter((scorer) => scorer.enabled) };
}
