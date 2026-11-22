import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import {
  defaultOrganizationFlagDeps,
  type OrganizationFlagDeps,
} from "@/lib/platform/organization-flags";
import { createDrizzleEvalStore } from "./adapters/drizzle-store";
import {
  type EvalForm,
  formFromEval,
  parseEvalForm,
  parseSpecForm,
  specChanges,
} from "./domain/edit";
import type { Eval, EvalRun } from "./domain/types";
import { EVALS_OFF_ERROR, evalsEnabledForActor } from "./gate";
import { type ActionResult, queueEvalRun } from "./run";
import {
  continueFromStep,
  editReplyAndRerun,
  type ReplyTarget,
  rerunEval,
  type StepRef,
  setStepAnswer,
} from "./steps";

/**
 * RC-297: save the eval editor (D4). The caller must be a member with
 * `cloud-eval-gate` on; the form is validated first, then the eval and its task
 * links are replaced together. "Save and run" also queues a manual run of
 * this one eval.
 */

export interface UpdateEvalDeps {
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
    evalId: string;
    run: boolean;
    turnCount: number;
    fixedAnswerCount: number;
    earlierCount: number;
  }) => Promise<void>;
}

export interface UpdatedEval {
  item: Eval;
  /** The queued run, with "Save and run". */
  run: EvalRun | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const logger = getLogger("evals/edit");

/** RC-641: the step actions' deps. `track` gets one event per action that changed something. */
export interface StepActionDeps extends Omit<UpdateEvalDeps, "track"> {
  track?: (event: StepActionEvent) => Promise<void>;
}

export type StepActionEvent = {
  externalId: string;
  projectId: string;
  organizationId: string;
  evalId: string;
} & (
  | { action: "step_answer_set"; runId: string; step: number }
  | { action: "rerun"; runId: string }
  | { action: "continued_from_step"; runId: string; step: number; copyId: string }
  | { action: "reply_edited"; runId: string; step: number; target: ReplyTarget; targetId: string }
);

export async function updateEval(
  projectId: string,
  evalId: string,
  form: EvalForm,
  andRun: boolean,
  deps: UpdateEvalDeps,
): Promise<ActionResult<UpdatedEval>> {
  const allowed = await allowedActor(projectId, deps);
  if (!allowed.ok) return allowed;
  const { actor, db } = allowed.value;
  const scope = {
    project: { id: allowed.value.project },
    organization: { id: allowed.value.organization },
  };
  const parsed = parseEvalForm(form);
  if (!parsed.ok) return parsed;
  const store = createDrizzleEvalStore(db);
  const current = UUID.test(evalId) ? await store.getEval(scope.project.id, evalId) : null;
  if (!current || current.status === "archived")
    return { ok: false, error: "No eval in this project has that ID." };
  // RC-641: only the spec fields the person changed are set, so the others stay `generated`.
  const { spec, ...fields } = parsed.value;
  const item = await store.updateEval(scope.project.id, evalId, {
    ...fields,
    ...(spec ? specChanges(current, spec) : {}),
  });
  if (!item) return { ok: false, error: "No eval in this project has that ID." };
  let run: EvalRun | null = null;
  if (andRun) {
    const queued = await queueEvalRun(scope.project.id, actor, null, db, "manual", undefined, {
      id: item.id,
      name: item.name,
    });
    if (!queued.ok) return queued;
    run = queued.value.run;
  }
  logger.info(
    { project_id: scope.project.id, eval_id: evalId, actor, run_id: run?.id ?? null },
    "eval_updated",
  );
  await deps.track?.({
    externalId: actor,
    projectId: scope.project.id,
    organizationId: scope.organization.id,
    evalId,
    run: andRun,
    turnCount: item.turns.length + 1,
    fixedAnswerCount: item.fixedAnswers.length,
    earlierCount: item.earlierMessages.length,
  });
  return { ok: true, value: { item, run } };
}

/** RC-641: "Simulate again" at a tool step: save the step's answer as a fixed answer, then queue a run of this eval. */
export async function simulateStepAgain(
  projectId: string,
  ref: StepRef,
  answer: string,
  deps: StepActionDeps,
): Promise<ActionResult<{ item: Eval; run: EvalRun }>> {
  const allowed = await allowedActor(projectId, deps);
  if (!allowed.ok) return allowed;
  const { project, organization, actor, db } = allowed.value;
  const saved =
    UUID.test(ref.evalId) && UUID.test(ref.runId)
      ? await setStepAnswer(project, actor, ref, answer, db)
      : { ok: false as const, error: "No eval in this project has that ID." };
  if (!saved.ok) return saved;
  await deps.track?.({
    externalId: actor,
    projectId: project,
    organizationId: organization,
    evalId: ref.evalId,
    action: "step_answer_set",
    runId: ref.runId,
    step: ref.step,
  });
  const queued = await rerunEval(project, actor, ref.evalId, db);
  if (!queued.ok) return queued;
  await deps.track?.({
    externalId: actor,
    projectId: project,
    organizationId: organization,
    evalId: ref.evalId,
    action: "rerun",
    runId: queued.value.run.id,
  });
  return { ok: true, value: { item: saved.value, run: queued.value.run } };
}

/** RC-642: "Simulate again" after an edit of the system prompt or the message at the replay: save that field, then queue a run of this eval. */
export async function simulateSpecAgain(
  projectId: string,
  evalId: string,
  change: { systemPrompt?: string; message?: string },
  deps: StepActionDeps,
): Promise<ActionResult<{ item: Eval; run: EvalRun }>> {
  const allowed = await allowedActor(projectId, deps);
  if (!allowed.ok) return allowed;
  const { project, organization, actor, db } = allowed.value;
  const store = createDrizzleEvalStore(db);
  const current = UUID.test(evalId) ? await store.getEval(project, evalId) : null;
  if (!current || current.status === "archived")
    return { ok: false, error: "No eval in this project has that ID." };
  const parsed = parseSpecForm({ ...formFromEval(current, []).spec!, ...change });
  if (!parsed.ok) return parsed;
  const item = await store.updateEval(project, current.id, {
    name: current.name,
    earlierMessages: current.earlierMessages,
    turns: current.turns,
    tasks: current.tasks,
    checks: current.checks,
    expectedTool: current.expectedTool,
    criteria: current.criteria,
    fixedAnswers: current.fixedAnswers,
    ...specChanges(current, parsed.value),
  });
  if (!item) return { ok: false, error: "No eval in this project has that ID." };
  const queued = await rerunEval(project, actor, item.id, db);
  if (!queued.ok) return queued;
  await deps.track?.({
    externalId: actor,
    projectId: project,
    organizationId: organization,
    evalId: item.id,
    action: "rerun",
    runId: queued.value.run.id,
  });
  return { ok: true, value: { item, run: queued.value.run } };
}

/** RC-641: "Simulate again" with no change: queue a run of this eval. */
export async function rerunEvalAs(
  projectId: string,
  evalId: string,
  deps: StepActionDeps,
): Promise<ActionResult<EvalRun>> {
  const allowed = await allowedActor(projectId, deps);
  if (!allowed.ok) return allowed;
  const { project, organization, actor, db } = allowed.value;
  const queued = UUID.test(evalId)
    ? await rerunEval(project, actor, evalId, db)
    : { ok: false as const, error: "No eval in this project has that ID." };
  if (!queued.ok) return queued;
  await deps.track?.({
    externalId: actor,
    projectId: project,
    organizationId: organization,
    evalId,
    action: "rerun",
    runId: queued.value.run.id,
  });
  return { ok: true, value: queued.value.run };
}

/** RC-641: "Continue from here": a copy of the eval with the run's steps 0..step as earlier messages, and a run of it. */
export async function continueFromStepAs(
  projectId: string,
  ref: StepRef,
  deps: StepActionDeps,
): Promise<ActionResult<{ item: Eval; run: EvalRun }>> {
  const allowed = await allowedActor(projectId, deps);
  if (!allowed.ok) return allowed;
  const { project, organization, actor, db } = allowed.value;
  const copied =
    UUID.test(ref.evalId) && UUID.test(ref.runId)
      ? await continueFromStep(project, actor, ref, db)
      : { ok: false as const, error: "No eval in this project has that ID." };
  if (!copied.ok) return copied;
  await deps.track?.({
    externalId: actor,
    projectId: project,
    organizationId: organization,
    evalId: ref.evalId,
    action: "continued_from_step",
    runId: copied.value.run.id,
    step: ref.step,
    copyId: copied.value.item.id,
  });
  return { ok: true, value: { item: copied.value.item, run: copied.value.run } };
}

/** RC-654: "Edit reply": run this eval, or a copy, from the edited agent reply at a step. */
export async function editReplyAndRerunAs(
  projectId: string,
  ref: StepRef,
  reply: unknown,
  target: ReplyTarget,
  deps: StepActionDeps,
): Promise<ActionResult<{ item: Eval; run: EvalRun }>> {
  const allowed = await allowedActor(projectId, deps);
  if (!allowed.ok) return allowed;
  const { project, organization, actor, db } = allowed.value;
  if (target !== "this" && target !== "copy")
    return { ok: false, error: "Choose this eval or a copy." };
  const edited =
    UUID.test(ref.evalId) && UUID.test(ref.runId)
      ? await editReplyAndRerun(project, actor, ref, reply, target, db)
      : { ok: false as const, error: "No eval in this project has that ID." };
  if (!edited.ok) return edited;
  const { item, run } = edited.value;
  await deps.track?.({
    externalId: actor,
    projectId: project,
    organizationId: organization,
    evalId: ref.evalId,
    action: "reply_edited",
    runId: ref.runId,
    step: ref.step,
    target,
    targetId: item.id,
  });
  await deps.track?.({
    externalId: actor,
    projectId: project,
    organizationId: organization,
    evalId: item.id,
    action: "rerun",
    runId: run.id,
  });
  return { ok: true, value: { item, run } };
}

/** The signed-in member of the project, with `cloud-eval-gate` on. */
async function allowedActor(
  projectId: string,
  deps: Omit<UpdateEvalDeps, "track">,
): Promise<
  ActionResult<{
    project: string;
    organization: string;
    actor: string;
    db: ReturnType<typeof getDb>;
  }>
> {
  const session = await deps.getSession();
  if (!session) return { ok: false, error: "Sign in to edit evals." };
  const scope = UUID.test(projectId)
    ? await deps.findProjectScope(projectId, session.user.id)
    : null;
  if (!scope) return { ok: false, error: "No project you belong to has that ID." };
  const db = deps.db ?? getDb();
  const actor = session.user.externalId;
  if (
    !(await evalsEnabledForActor(
      scope.project.id,
      actor,
      db,
      deps.flagDeps ?? defaultOrganizationFlagDeps,
    ))
  )
    return { ok: false, error: EVALS_OFF_ERROR };
  return {
    ok: true,
    value: { project: scope.project.id, organization: scope.organization.id, actor, db },
  };
}
