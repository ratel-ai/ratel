import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { parseProjectUuid } from "@/lib/console/scope/cookie";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { type EvalDb, findRun } from "@/lib/views/eval-gate/runs";
import { taskEvalCases, taskEvalSets } from "@/lib/views/task-evals/schema";
import { SCORER_VERSION } from "@/lib/views/task-scorers/engine";
import { type TestProposal, testProposalSchema } from "./test-proposal";

export type TaskEvalActionInput = { projectId: string; taskId: string } & (
  | { action: "pin" | "unpin" | "exclude"; caseId: string }
  | { action: "add"; runId: string; proposal?: TestProposal }
  | { action: "refresh" }
);
export type TaskEvalActionResult =
  | { ok: true; message: string; jobId?: string }
  | { ok: false; error: string };
export type TaskEvalChangeEvent = {
  project_id: string;
  organization_id: string;
  task_id: string;
  actor: string;
  action: TaskEvalActionInput["action"];
  case_id?: string;
  turn_id?: string;
  test_saved?: boolean;
};
export interface TaskEvalActionDeps {
  db?: EvalDb;
  getSession(): Promise<{ user: { id: string; externalId: string } } | null>;
  findProjectScope(
    projectId: string,
    userId: string,
  ): Promise<{ project: { id: string }; organization: { id: string } } | null>;
  enabled(projectId: string, actor: string): Promise<boolean>;
  enqueue(projectId: string, taskId: string): Promise<{ id: string } | null>;
  observe(fields: TaskEvalChangeEvent): Promise<void>;
  now?: () => Date;
}

/** Require membership and the project flag before an eval change. */
export async function changeTaskEval(
  raw: unknown,
  deps: TaskEvalActionDeps,
): Promise<TaskEvalActionResult> {
  const input = parseInput(raw);
  if (!input) return { ok: false, error: "The eval settings are invalid." };
  const session = await deps.getSession();
  if (!session) return { ok: false, error: "Sign in to edit evals." };
  const scope = await deps.findProjectScope(input.projectId, session.user.id);
  if (!scope) return { ok: false, error: "You cannot edit this project's evals." };
  const actor = session.user.externalId;
  if (!(await deps.enabled(scope.project.id, actor)))
    return { ok: false, error: "Evals are off for this project." };
  const fields: TaskEvalChangeEvent = {
    project_id: scope.project.id,
    organization_id: scope.organization.id,
    task_id: input.taskId,
    actor,
    action: input.action,
  };
  if (input.action === "refresh") {
    const job = await deps.enqueue(scope.project.id, input.taskId);
    if (!job) return { ok: false, error: "Could not queue the refresh. Try again." };
    await deps.observe(fields);
    return { ok: true, message: "Refreshing…", jobId: job.id };
  }
  const db = deps.db ?? getDb();
  if (input.action === "add") {
    const run = await findRun(scope.project.id, input.runId, db);
    if (!run) return { ok: false, error: "No run in this project has that ID." };
    const [closed] = await db
      .select({ id: traceTurns.id })
      .from(traceTurns)
      .where(
        and(
          eq(traceTurns.projectId, scope.project.id),
          eq(traceTurns.id, run.turnId),
          eq(traceTurns.status, "closed"),
          input.proposal ? eq(traceTurns.workflowId, input.taskId) : undefined,
        ),
      )
      .limit(1);
    if (!closed) return { ok: false, error: "Only completed runs can enter the eval set." };
    const proposal = input.proposal;
    const edited = proposal
      ? {
          expected: proposal.expected,
          criteria: proposal.criteria,
          testName: proposal.name,
          testAsk: proposal.ask,
        }
      : {};
    await db
      .insert(taskEvalSets)
      .values({ projectId: scope.project.id, taskId: input.taskId, scorerVersion: SCORER_VERSION })
      .onConflictDoNothing();
    const [row] = await db
      .insert(taskEvalCases)
      .values({
        projectId: scope.project.id,
        taskId: input.taskId,
        turnId: run.turnId,
        origin: "user",
        selectionReason: "Added by you.",
        ...edited,
      })
      .onConflictDoUpdate({
        target: [
          taskEvalCases.projectId,
          taskEvalCases.taskId,
          taskEvalCases.fixId,
          taskEvalCases.turnId,
        ],
        set: { origin: "user", excludedAt: null, selectionReason: "Added by you.", ...edited },
        setWhere: proposal ? isNotNull(taskEvalCases.excludedAt) : undefined,
      })
      .returning({ id: taskEvalCases.id });
    if (!row) return { ok: false, error: "This run is already in the eval set." };
    await deps.observe({
      ...fields,
      case_id: row.id,
      turn_id: run.turnId,
      ...(proposal ? { test_saved: true } : {}),
    });
    return { ok: true, message: "Run added." };
  }
  const [row] = await db
    .update(taskEvalCases)
    .set(
      input.action === "exclude"
        ? { excludedAt: deps.now?.() ?? new Date(), pinned: false }
        : { pinned: input.action === "pin" },
    )
    .where(
      and(
        eq(taskEvalCases.projectId, scope.project.id),
        eq(taskEvalCases.taskId, input.taskId),
        eq(taskEvalCases.id, input.caseId),
        isNull(taskEvalCases.fixId),
        isNull(taskEvalCases.excludedAt),
      ),
    )
    .returning({ id: taskEvalCases.id, turnId: taskEvalCases.turnId });
  if (!row) return { ok: false, error: "This run is no longer in the task's eval set." };
  await deps.observe({ ...fields, case_id: row.id, turn_id: row.turnId });
  return {
    ok: true,
    message:
      input.action === "pin"
        ? "Run pinned."
        : input.action === "unpin"
          ? "Run unpinned."
          : "Run excluded.",
  };
}

function parseInput(raw: unknown): TaskEvalActionInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.projectId !== "string" || typeof value.taskId !== "string") return null;
  const projectId = parseProjectUuid(value.projectId);
  const taskId = value.taskId.trim();
  if (!projectId || !taskId || taskId.length > 500) return null;
  if (value.action === "refresh") return { projectId, taskId, action: "refresh" };
  if (
    value.action === "add" &&
    typeof value.runId === "string" &&
    value.runId.trim() &&
    value.runId.trim().length <= 200
  ) {
    if (value.proposal !== undefined) {
      const proposal = testProposalSchema.safeParse(value.proposal);
      if (!proposal.success) return null;
      return {
        projectId,
        taskId,
        action: "add",
        runId: value.runId.trim(),
        proposal: proposal.data,
      };
    }
    return { projectId, taskId, action: "add", runId: value.runId.trim() };
  }
  if (
    (value.action === "pin" || value.action === "unpin" || value.action === "exclude") &&
    typeof value.caseId === "string" &&
    parseProjectUuid(value.caseId)
  ) {
    return { projectId, taskId, action: value.action, caseId: value.caseId };
  }
  return null;
}
