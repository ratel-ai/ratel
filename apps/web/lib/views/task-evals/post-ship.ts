import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { jobs } from "@/lib/jobs/schema";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { getLogger, runWithLogContext } from "@/lib/platform/logger";
import { projects } from "@/lib/platform/projects/schema";
import { judgeCriteria } from "@/lib/views/eval-gate/judge";
import {
  DAILY_ORG_BUDGET_USD,
  JUDGE_BUDGET_USD,
  resolveEvalModels,
  SpendMeter,
} from "@/lib/views/eval-gate/models";
import { type EvalDb, loadRuns } from "@/lib/views/eval-gate/runs";
import { recordedView } from "@/lib/views/eval-gate/simulate";
import { lockOrganizationSpend, organizationModelSpendSince } from "@/lib/views/eval-gate/store";
import type { RunRecord, Tally } from "@/lib/views/eval-gate/types";
import { type FixShipmentRow, fixShipments, fixShipmentTasks } from "@/lib/views/fixes/schema";
import type { Fix } from "@/lib/views/fixes/types";
import { type TaskEvalRunRow, taskEvalCases, taskEvalRuns } from "@/lib/views/task-evals/schema";
import type { TaskSimulationDeps } from "@/lib/views/task-evals/simulation";
import { SCORER_VERSION, scoreRun } from "@/lib/views/task-scorers/engine";
import { scorersFor } from "@/lib/views/task-scorers/store";
import type { Scorer } from "@/lib/views/task-scorers/types";

export type PostShipComparison = Record<
  string,
  { baseline: Tally | null; predicted: Tally | null; actual: Tally }
>;
type TransactionDb = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
type Snapshot = {
  scorers: Scorer[];
  baseline: Record<string, Tally>;
  predicted: Record<string, Tally>;
};
const DAY_MS = 86_400_000;
const logger = getLogger("task-evals/post-ship");

/** Record each task and its measurement in the shipment transaction. */
export async function queuePostShipMeasures(shipment: FixShipmentRow, fix: Fix, db: TransactionDb) {
  for (const taskId of new Set(fix.subject.tasks.map((task) => task.id))) {
    await db.insert(fixShipmentTasks).values({ shipmentId: shipment.id, taskId });
    const [simulation] = await db
      .select()
      .from(taskEvalRuns)
      .where(
        and(
          eq(taskEvalRuns.projectId, shipment.projectId),
          eq(taskEvalRuns.fixId, fix.id),
          eq(taskEvalRuns.taskId, taskId),
          eq(taskEvalRuns.kind, "simulation"),
          eq(taskEvalRuns.status, "completed"),
        ),
      )
      .orderBy(desc(taskEvalRuns.createdAt), desc(taskEvalRuns.id))
      .limit(1);
    const scorers =
      (simulation?.change?.scorers as Scorer[] | undefined) ??
      (await scorersFor(shipment.projectId, taskId, db)).filter((scorer) => scorer.enabled);
    const pairs = simulation?.breakdown?.task as
      | Record<string, { before: Tally; after: Tally }>
      | undefined;
    const baseline = await evalBaseline(shipment.projectId, taskId, scorers, db);
    for (const [kind, pair] of Object.entries(pairs ?? {})) {
      if (pair.before.passRate !== null) baseline[kind] = pair.before;
    }
    const predicted = pairs
      ? Object.fromEntries(Object.entries(pairs).map(([kind, pair]) => [kind, pair.after]))
      : {};
    // A later release replaces the observation window of an unfinished release.
    await db
      .update(taskEvalRuns)
      .set({
        status: "failed",
        error: "A later shipment replaced this measurement.",
        finishedAt: shipment.shippedAt,
      })
      .where(
        and(
          eq(taskEvalRuns.projectId, shipment.projectId),
          eq(taskEvalRuns.fixId, fix.id),
          eq(taskEvalRuns.taskId, taskId),
          eq(taskEvalRuns.kind, "post_ship"),
          inArray(taskEvalRuns.status, ["queued", "running"]),
        ),
      );
    const [run] = await db
      .insert(taskEvalRuns)
      .values({
        projectId: shipment.projectId,
        taskId,
        fixId: fix.id,
        shipmentId: shipment.id,
        kind: "post_ship",
        scorerVersion: simulation?.scorerVersion ?? SCORER_VERSION,
        createdBy: shipment.shippedBy,
        createdAt: shipment.shippedAt,
        change: { scorers, baseline, predicted, simulationId: simulation?.id ?? null },
      })
      .returning();
    await db.insert(jobs).values({
      projectId: shipment.projectId,
      kind: "simulate_task_eval",
      payload: { runId: run!.id },
      createdAt: shipment.shippedAt,
    });
    logger.info(
      {
        project_id: shipment.projectId,
        task_id: taskId,
        fix_id: fix.id,
        shipment_id: shipment.id,
        n_runs: 0,
        waited_days: 0,
      },
      "post_ship_measure_queued",
    );
  }
}

/** Wait for 20 closed runs or seven days, then score the release with frozen scorers. */
export async function measurePostShip(
  run: TaskEvalRunRow,
  db: ReturnType<typeof getDb>,
  now: Date,
  deps: TaskSimulationDeps = {},
) {
  const prepared = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(taskEvalRuns)
      .where(and(eq(taskEvalRuns.id, run.id), eq(taskEvalRuns.projectId, run.projectId)))
      .for("update");
    if (!locked || locked.status !== "queued")
      return { simulated: locked?.status === "completed", status: locked?.status };
    const [shipment] = await tx
      .select()
      .from(fixShipments)
      .where(and(eq(fixShipments.id, run.shipmentId!), eq(fixShipments.projectId, run.projectId)));
    if (!shipment) throw new Error("The shipment does not exist in the project.");
    if (run.scorerVersion !== SCORER_VERSION) {
      await tx
        .update(taskEvalRuns)
        .set({
          status: "failed",
          error: "The scorer engine changed. Mark the fix as live again.",
          finishedAt: now,
        })
        .where(eq(taskEvalRuns.id, run.id));
      return { simulated: false, reason: "scorer_version_changed" };
    }
    const deadline = new Date(shipment.shippedAt.getTime() + 7 * DAY_MS);
    const candidates = await tx
      .select({ id: traceTurns.id })
      .from(traceTurns)
      .where(
        and(
          eq(traceTurns.projectId, run.projectId),
          eq(traceTurns.workflowId, run.taskId),
          eq(traceTurns.status, "closed"),
          gt(traceTurns.startedAt, shipment.shippedAt),
          lte(traceTurns.endedAt, new Date(Math.min(now.getTime(), deadline.getTime()))),
        ),
      )
      .orderBy(asc(traceTurns.endedAt), asc(traceTurns.id))
      .limit(500);
    if (candidates.length < 20 && now < deadline) {
      const [pending] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.projectId, run.projectId),
            eq(jobs.kind, "simulate_task_eval"),
            eq(jobs.status, "queued"),
            sql`${jobs.payload}->>'runId' = ${run.id}`,
            gt(jobs.createdAt, now),
          ),
        )
        .limit(1);
      if (!pending)
        await tx.insert(jobs).values({
          projectId: run.projectId,
          kind: "simulate_task_eval",
          payload: { runId: run.id },
          createdAt: new Date(Math.min(now.getTime() + 3_600_000, deadline.getTime())),
        });
      return { simulated: false, reason: "waiting_for_runs", nRuns: candidates.length };
    }
    const snapshot = run.change as unknown as Snapshot;
    const records = [
      ...(
        await loadRuns(
          run.projectId,
          candidates.map((item) => item.id),
          tx,
        )
      ).values(),
    ];
    const criteria = snapshot.scorers.find((scorer) => scorer.kind === "judge_criteria");
    let cap = 0;
    let organizationId: string | undefined;
    if (criteria && records.length) {
      // Owned (ADR-0030): the core has no organizations table; the advisory lock stands in.
      const [org] = await tx
        .select({ id: projects.organizationId })
        .from(projects)
        .where(eq(projects.id, run.projectId));
      if (!org || !(await lockOrganizationSpend(run.projectId, tx)))
        throw new Error("The measurement project does not exist.");
      organizationId = org.id;
      const spent = await organizationModelSpendSince(
        run.projectId,
        new Date(now.getTime() - DAY_MS),
        tx,
      );
      cap = Math.max(
        0,
        Math.min(
          deps.judgeBudgetUsd ?? JUDGE_BUDGET_USD,
          (deps.dailyBudgetUsd ?? DAILY_ORG_BUDGET_USD) - spent,
        ),
      );
    }
    await tx
      .update(taskEvalRuns)
      .set({
        status: "running",
        startedAt: now,
        spend: criteria ? { usd: cap, reserved: true } : null,
      })
      .where(eq(taskEvalRuns.id, run.id));
    return { ready: true as const, records, snapshot, criteria, cap, organizationId, shipment };
  });
  if (prepared.ready !== true) return prepared;
  const { records, snapshot, criteria, cap, organizationId, shipment } = prepared;
  let spend: Record<string, unknown> | null = null;
  let readings: Map<string, { before: boolean | null; after: boolean | null }> | undefined;
  if (criteria?.kind === "judge_criteria" && records.length) {
    const meter = new SpendMeter(cap);
    const models = deps.models ?? resolveEvalModels(undefined, "eval_gate_task_judge");
    const judged = await runWithLogContext(
      { project_id: run.projectId, org_id: organizationId },
      () =>
        judgeCriteria(
          records.map((record) => ({
            caseId: record.turnId,
            criteria: criteria.criteria,
            before: recordedView(record, null),
            after: recordedView(record, null),
          })),
          models.judge,
          meter,
          "eval_gate_task_judge",
        ),
    );
    readings = judged.readings;
    spend = {
      usd: judged.status.status === "budget" ? cap : meter.usd,
      calls: meter.calls,
      models: [...meter.models],
    };
  }
  const actual = tallyRuns(records, snapshot.scorers, readings);
  const comparison: PostShipComparison = Object.fromEntries(
    snapshot.scorers.map((scorer) => [
      scorer.kind,
      {
        baseline: snapshot.baseline[scorer.kind] ?? null,
        predicted: snapshot.predicted[scorer.kind] ?? null,
        actual: actual[scorer.kind]!,
      },
    ]),
  );
  await db
    .update(taskEvalRuns)
    .set({
      status: "completed",
      before: snapshot.baseline,
      after: actual,
      breakdown: { comparison },
      spend,
      caseCount: records.length,
      finishedAt: now,
    })
    .where(and(eq(taskEvalRuns.id, run.id), eq(taskEvalRuns.status, "running")));
  logger.info(
    {
      project_id: run.projectId,
      task_id: run.taskId,
      fix_id: run.fixId,
      shipment_id: shipment.id,
      n_runs: records.length,
      waited_days: Math.max(0, (now.getTime() - shipment.shippedAt.getTime()) / DAY_MS),
    },
    "post_ship_measure_finished",
  );
  return { simulated: true, status: "completed", runId: run.id };
}

/** Read shipment markers and preserved comparisons for one task. Callers enforce access. */
export async function taskShipmentsFor(projectId: string, taskId: string, db: EvalDb = getDb()) {
  const rows = await db
    .select({ shipment: fixShipments, measure: taskEvalRuns })
    .from(fixShipmentTasks)
    .innerJoin(fixShipments, eq(fixShipments.id, fixShipmentTasks.shipmentId))
    .leftJoin(
      taskEvalRuns,
      and(
        eq(taskEvalRuns.shipmentId, fixShipments.id),
        eq(taskEvalRuns.projectId, projectId),
        eq(taskEvalRuns.taskId, taskId),
        eq(taskEvalRuns.kind, "post_ship"),
      ),
    )
    .where(and(eq(fixShipments.projectId, projectId), eq(fixShipmentTasks.taskId, taskId)))
    .orderBy(desc(fixShipments.shippedAt))
    .limit(50);
  return rows.map(({ shipment, measure }) => ({
    id: shipment.id,
    fixId: shipment.fixId,
    version: shipment.version,
    shippedAt: shipment.shippedAt.toISOString(),
    notes: shipment.notes,
    status: measure?.status ?? "queued",
    nRuns: measure?.caseCount ?? 0,
    error: measure?.error ?? null,
    comparison: (measure?.breakdown?.comparison ?? null) as PostShipComparison | null,
  }));
}

async function evalBaseline(projectId: string, taskId: string, scorers: Scorer[], db: EvalDb) {
  const cases = await db
    .select({ turnId: taskEvalCases.turnId })
    .from(taskEvalCases)
    .where(
      and(
        eq(taskEvalCases.projectId, projectId),
        eq(taskEvalCases.taskId, taskId),
        isNull(taskEvalCases.fixId),
        isNull(taskEvalCases.excludedAt),
      ),
    );
  return tallyRuns(
    [
      ...(
        await loadRuns(
          projectId,
          cases.map((item) => item.turnId),
          db,
        )
      ).values(),
    ],
    scorers,
  );
}

function tallyRuns(
  runs: RunRecord[],
  scorers: Scorer[],
  readings?: Map<string, { before: boolean | null }>,
): Record<string, Tally> {
  const tool = scorers.find((scorer) => scorer.kind === "expected_tool");
  const results = runs.flatMap((run) =>
    scoreRun(
      {
        ...recordedView(run, tool?.kind === "expected_tool" ? tool.tool : null),
        criteriaPass: readings?.get(run.turnId)?.before,
      },
      scorers,
    ),
  );
  return Object.fromEntries(
    scorers.map((scorer) => {
      const measured = results.filter(
        (result) => result.kind === scorer.kind && result.status !== "skip",
      );
      const passed = measured.filter((result) => result.status === "pass").length;
      return [
        scorer.kind,
        {
          passed,
          total: measured.length,
          passRate: measured.length ? passed / measured.length : null,
          score: measured.length
            ? measured.reduce((sum, result) => sum + result.score, 0) / measured.length
            : null,
        },
      ];
    }),
  );
}
