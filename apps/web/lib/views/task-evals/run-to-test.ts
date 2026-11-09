import { and, eq, isNull } from "drizzle-orm";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { getLogger, runWithLogContext } from "@/lib/platform/logger";
import { projects } from "@/lib/platform/projects/schema";
import { loadAskSourcesByTurn } from "@/lib/readings/trace-signals/workflows/label-queries";
import { loadModelCalls } from "@/lib/views/eval-gate/calls";
import { EVAL_GATE_OFF_ERROR, evalGateEnabledForActor } from "@/lib/views/eval-gate/gate";
import {
  DAILY_ORG_BUDGET_USD,
  estimateTokens,
  recordBudgetRefusal,
  resolveTestDraftModel,
  SMALL_MAX_TOKENS,
  SpendMeter,
  TEST_DRAFT_PROMPT,
  type TestDraftModel,
} from "@/lib/views/eval-gate/models";
import { type EvalDb, loadRuns } from "@/lib/views/eval-gate/runs";
import { lockOrganizationSpend, organizationModelSpendSince } from "@/lib/views/eval-gate/store";
import type { OrganizationFlagDeps } from "@/lib/views/task-evals/store";
// Owned (ADR-0030): the task loop's spend joins the daily budget through the eval gate's seam.
import "@/lib/views/task-evals/spend";
import { taskEvalCases, taskTestDrafts } from "@/lib/views/task-evals/schema";
import { type TestProposal, testProposalSchema } from "@/lib/views/task-evals/test-proposal";
import { scorersFor } from "@/lib/views/task-scorers/store";

export interface RunTestDraftDeps {
  db?: ReturnType<typeof getDb>;
  actor?: string;
  flagDeps?: OrganizationFlagDeps;
  model?: TestDraftModel | null;
  dailyBudgetUsd?: number;
  now?: () => Date;
}
export class TestDraftError extends Error {}

const logger = getLogger("task-evals/run-to-test");

/** Draft a test from a completed run in this task and project. */
export async function draftTestFromRun(
  projectId: string,
  taskId: string,
  turnId: string,
  deps: RunTestDraftDeps = {},
): Promise<TestProposal> {
  const db = deps.db ?? getDb();
  if (
    !(await evalGateEnabledForActor(
      projectId,
      deps.actor ?? "system:task-evals",
      db,
      deps.flagDeps,
    ))
  )
    throw new TestDraftError(EVAL_GATE_OFF_ERROR);
  const [turn] = await db
    .select({ id: traceTurns.id })
    .from(traceTurns)
    .where(
      and(
        eq(traceTurns.projectId, projectId),
        eq(traceTurns.workflowId, taskId),
        eq(traceTurns.id, turnId),
        eq(traceTurns.status, "closed"),
      ),
    )
    .limit(1);
  if (!turn) throw new TestDraftError("No completed run in this task and project has that ID.");
  if (await runIsInEvalSet(projectId, taskId, turnId, db))
    throw new TestDraftError("This run is already in the eval set.");
  const model = deps.model === undefined ? resolveTestDraftModel() : deps.model;
  if (!model) throw new TestDraftError("No model is configured to draft a test.");
  const run = (await loadRuns(projectId, [turnId], db)).get(turnId);
  if (!run) throw new TestDraftError("The recorded run is no longer available.");
  const calls = await loadModelCalls(
    projectId,
    [
      {
        turnId,
        startedAt: new Date(run.startedAt),
        endedAt: new Date(run.endedAt ?? run.startedAt),
        traceIds: run.traceIds ?? [],
      },
    ],
    { withPayload: true },
    db,
  );
  const asks = await loadAskSourcesByTurn(projectId, [turnId], db);
  const scorers = (await scorersFor(projectId, taskId, db)).filter((scorer) => scorer.enabled);
  const input = JSON.stringify({
    taskId,
    ask: asks.get(turnId)?.text ?? null,
    run,
    scorers,
    messages: (calls.get(turnId) ?? [])
      .flatMap((call) => call.payload?.messages ?? [])
      .slice(0, 20),
  });
  if (input.length > 80000) throw new TestDraftError("This run is too large to draft a test.");
  const now = deps.now?.() ?? new Date();
  const meter = new SpendMeter(deps.dailyBudgetUsd ?? DAILY_ORG_BUDGET_USD);
  // Use a conservative input estimate for the reservation.
  const estimated = meter.price(model.model, {
    inputTokens: estimateTokens(input, TEST_DRAFT_PROMPT) * 4,
    outputTokens: SMALL_MAX_TOKENS,
  });
  const held = await db.transaction(async (tx) => {
    // Owned (ADR-0030): the core has no organizations table; the advisory lock stands in.
    const [org] = await tx
      .select({ id: projects.organizationId })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!org || !(await lockOrganizationSpend(projectId, tx)))
      throw new TestDraftError("The task project does not exist.");
    const spent = await organizationModelSpendSince(
      projectId,
      new Date(now.getTime() - 86400000),
      tx,
    );
    if (spent >= meter.capUsd || spent + estimated > meter.capUsd) {
      runWithLogContext({ project_id: projectId, org_id: org.id }, () =>
        recordBudgetRefusal(model, "eval_gate_task_test_draft"),
      );
      logger.info(
        {
          project_id: projectId,
          task_id: taskId,
          turn_id: turnId,
          model: model.model,
          cost_usd: 0,
          outcome: "refused_budget",
        },
        "task_test_drafted",
      );
      throw new TestDraftError("The daily model budget is spent. Try again tomorrow.");
    }
    const [row] = await tx
      .insert(taskTestDrafts)
      .values({
        projectId,
        taskId,
        turnId,
        spend: { usd: estimated, reserved: true },
        createdAt: now,
      })
      .returning();
    return { id: row!.id, organizationId: org.id };
  });
  let usd = estimated;
  let outcome = "failed";
  try {
    const reply = await runWithLogContext(
      { project_id: projectId, org_id: held.organizationId },
      () => model.draft(input),
    );
    usd = meter.price(model.model, reply.usage);
    let raw: unknown;
    try {
      raw = JSON.parse(reply.text);
    } catch {
      throw new TestDraftError("The model returned an invalid test proposal. Try again.");
    }
    const parsed = testProposalSchema.safeParse(raw);
    if (!parsed.success)
      throw new TestDraftError("The model returned an invalid test proposal. Try again.");
    outcome = "drafted";
    return parsed.data;
  } catch (err) {
    logger.error(
      { err, project_id: projectId, task_id: taskId, turn_id: turnId },
      "task test draft failed",
    );
    throw err;
  } finally {
    await db
      .update(taskTestDrafts)
      .set({ spend: { usd, reserved: false } })
      .where(eq(taskTestDrafts.id, held.id));
    logger.info(
      {
        project_id: projectId,
        task_id: taskId,
        turn_id: turnId,
        model: model.model,
        cost_usd: usd,
        outcome,
      },
      "task_test_drafted",
    );
  }
}

export async function runIsInEvalSet(
  projectId: string,
  taskId: string,
  turnId: string,
  db: EvalDb = getDb(),
): Promise<boolean> {
  const [row] = await db
    .select({ id: taskEvalCases.id })
    .from(taskEvalCases)
    .where(
      and(
        eq(taskEvalCases.projectId, projectId),
        eq(taskEvalCases.taskId, taskId),
        eq(taskEvalCases.turnId, turnId),
        isNull(taskEvalCases.fixId),
        isNull(taskEvalCases.excludedAt),
      ),
    )
    .limit(1);
  return !!row;
}
