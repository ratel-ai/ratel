"use server";

import { revalidatePath } from "next/cache";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { getSessionContext } from "@/lib/platform/session";
import { trackServerEvent } from "@/lib/platform/telemetry";
import type { EvalForm } from "./domain/edit";
import type { RunSettings } from "./domain/run-settings";
import type { Eval, EvalRun, EvalStatus } from "./domain/types";
import {
  continueFromStepAs,
  editReplyAndRerunAs,
  rerunEvalAs,
  type StepActionDeps,
  simulateSpecAgain,
  simulateStepAgain,
  type UpdatedEval,
  updateEval,
} from "./edit";
import { type NightlySetting, setNightlyEvals } from "./nightly";
import { type ActionResult, requestEvalRun } from "./run";
import { saveRunSettings } from "./run-settings";
import { requestEvalSimulation } from "./simulation";
import type { ReplyTarget, StepRef } from "./steps";
import { removeEval } from "./suggest";

/**
 * Server actions for Evals (RC-289). Membership and `cloud-eval-gate` are checked
 * in `lib/evals/run.ts`; this file only binds the signed-in session to them.
 */

/** Queue a manual run of every eval, or of one task's evals. */
export async function runEvalsAction(
  projectId: string,
  workflowId: string | null = null,
): Promise<ActionResult<EvalRun>> {
  const result = await requestEvalRun(projectId, workflowId, {
    getSession: getSessionContext,
    findProjectScope,
    track: ({ externalId, projectId: id, organizationId, runId, evalCount, workflowId: task }) =>
      trackServerEvent(
        "eval_run_queued",
        { externalId, projectId: id, orgId: organizationId },
        { run_id: runId, eval_count: evalCount, workflow_id: task, actor: externalId },
      ),
  });
  if (result.ok) revalidatePath(`/project/${encodeURIComponent(projectId)}/evals`);
  return result;
}

/** Queue a simulation of a fix over a suite of the eval set: its own tasks' evals by default (RC-293). */
export async function simulateFixAction(
  projectId: string,
  fixId: string,
  suite?: unknown,
): Promise<ActionResult<EvalRun>> {
  const result = await requestEvalSimulation(projectId, fixId, suite, {
    getSession: getSessionContext,
    findProjectScope,
    track: ({
      externalId,
      projectId: id,
      organizationId,
      runId,
      fixId: fix,
      suite: kind,
      evalCount,
    }) =>
      trackServerEvent(
        "eval_simulation_queued",
        { externalId, projectId: id, orgId: organizationId },
        { run_id: runId, fix_id: fix, suite: kind, eval_count: evalCount, actor: externalId },
      ),
  });
  if (result.ok) {
    revalidatePath(`/project/${encodeURIComponent(projectId)}/evals`);
    revalidatePath(
      `/project/${encodeURIComponent(projectId)}/improvement/fixes/${encodeURIComponent(fixId)}`,
    );
  }
  return result;
}

/** Remove an eval from the set (archived), suggested or not (RC-315). */
export async function removeEvalAction(
  projectId: string,
  evalId: string,
): Promise<ActionResult<EvalStatus>> {
  const result = await removeEval(projectId, evalId, {
    getSession: getSessionContext,
    findProjectScope,
    track: ({ externalId, projectId: id, organizationId, evalId: target }) =>
      trackServerEvent(
        "eval_removed",
        { externalId, projectId: id, orgId: organizationId },
        { eval_id: target, actor: externalId },
      ),
  });
  if (result.ok) revalidatePath(`/project/${encodeURIComponent(projectId)}/evals`);
  return result;
}

/** Turn nightly runs of the eval set on or off (RC-299). Admins of paid organizations only; checked in `lib/evals/nightly.ts`. */
export async function setNightlyEvalsAction(
  projectId: string,
  enabled: boolean,
): Promise<ActionResult<NightlySetting>> {
  const result = await setNightlyEvals(projectId, enabled, {
    getSession: getSessionContext,
    findProjectScope,
    track: ({ externalId, projectId: id, organizationId, enabled: on }) =>
      trackServerEvent(
        "eval_nightly_changed",
        { externalId, projectId: id, orgId: organizationId },
        { enabled: on, actor: externalId },
      ),
  });
  if (result.ok) revalidatePath(`/project/${encodeURIComponent(projectId)}/evals/runs`);
  return result;
}

/** RC-297: save the eval editor; `andRun` also queues a run of this eval. */
export async function updateEvalAction(
  projectId: string,
  evalId: string,
  form: EvalForm,
  andRun: boolean,
): Promise<ActionResult<UpdatedEval>> {
  const result = await updateEval(projectId, evalId, form, andRun, {
    getSession: getSessionContext,
    findProjectScope,
    track: async ({
      externalId,
      projectId: id,
      organizationId,
      evalId: target,
      run,
      turnCount,
      fixedAnswerCount,
      earlierCount,
    }) => {
      await trackServerEvent(
        "eval_updated",
        { externalId, projectId: id, orgId: organizationId },
        {
          eval_id: target,
          and_run: run,
          turn_count: turnCount,
          fixed_answer_count: fixedAnswerCount,
          earlier_count: earlierCount,
          actor: externalId,
        },
      );
    },
  });
  if (result.ok) revalidatePath(`/project/${encodeURIComponent(projectId)}/evals`, "layout");
  return result;
}

/** RC-641: change the answer of a tool step and simulate the eval again. */
export async function simulateStepAgainAction(
  projectId: string,
  ref: StepRef,
  answer: string,
): Promise<ActionResult<{ item: Eval; run: EvalRun }>> {
  const result = await simulateStepAgain(projectId, ref, answer, stepActionDeps());
  if (result.ok) revalidatePath(`/project/${encodeURIComponent(projectId)}/evals`, "layout");
  return result;
}

/** RC-642: change the system prompt or the message at the replay and simulate the eval again. */
export async function simulateSpecAgainAction(
  projectId: string,
  evalId: string,
  change: { systemPrompt?: string; message?: string },
): Promise<ActionResult<{ item: Eval; run: EvalRun }>> {
  const result = await simulateSpecAgain(projectId, evalId, change, stepActionDeps());
  if (result.ok) revalidatePath(`/project/${encodeURIComponent(projectId)}/evals`, "layout");
  return result;
}

/** RC-641: simulate the eval again, unchanged. */
export async function rerunEvalAction(
  projectId: string,
  evalId: string,
): Promise<ActionResult<EvalRun>> {
  const result = await rerunEvalAs(projectId, evalId, stepActionDeps());
  if (result.ok) revalidatePath(`/project/${encodeURIComponent(projectId)}/evals`, "layout");
  return result;
}

/** RC-641: copy the eval with the run's steps up to this one as earlier messages, and run the copy. */
export async function continueFromStepAction(
  projectId: string,
  ref: StepRef,
): Promise<ActionResult<{ item: Eval; run: EvalRun }>> {
  const result = await continueFromStepAs(projectId, ref, stepActionDeps());
  if (result.ok) revalidatePath(`/project/${encodeURIComponent(projectId)}/evals`, "layout");
  return result;
}

/** RC-654: edit the agent reply at a step and run this eval, or a copy, from it. */
export async function editReplyAction(
  projectId: string,
  ref: StepRef,
  reply: { text: string; calls: { name: string; args: Record<string, unknown> }[] },
  target: ReplyTarget,
): Promise<ActionResult<{ item: Eval; run: EvalRun }>> {
  const result = await editReplyAndRerunAs(projectId, ref, reply, target, stepActionDeps());
  if (result.ok) revalidatePath(`/project/${encodeURIComponent(projectId)}/evals`, "layout");
  return result;
}

/** RC-653: save the run settings of one eval, or of the suite when `evalId` is null. */
export async function saveRunSettingsAction(
  projectId: string,
  evalId: string | null,
  settings: RunSettings,
): Promise<ActionResult<RunSettings>> {
  const result = await saveRunSettings(projectId, evalId, settings, {
    getSession: getSessionContext,
    findProjectScope,
    track: async ({
      externalId,
      projectId: id,
      organizationId,
      level,
      evalId: target,
      settings: keys,
    }) => {
      await trackServerEvent(
        "eval_run_settings_set",
        { externalId, projectId: id, orgId: organizationId },
        {
          object_action: "eval_run_settings_set",
          level,
          eval_id: target,
          settings: keys,
          actor: externalId,
        },
      );
    },
  });
  if (result.ok) revalidatePath(`/project/${encodeURIComponent(projectId)}/evals`, "layout");
  return result;
}

function stepActionDeps(): StepActionDeps {
  return {
    getSession: getSessionContext,
    findProjectScope,
    track: async ({ externalId, projectId, organizationId, evalId, ...fields }) => {
      const event =
        fields.action === "rerun"
          ? "eval_run_queued"
          : fields.action === "step_answer_set"
            ? "eval_step_answer_set"
            : fields.action === "reply_edited"
              ? "eval_reply_edited"
              : "eval_continued_from_step";
      await trackServerEvent(
        event,
        { externalId, projectId, orgId: organizationId },
        {
          object_action: event,
          eval_id: evalId,
          run_id: fields.runId,
          actor: externalId,
          ...(fields.action === "rerun"
            ? { eval_count: 1, workflow_id: null }
            : { step: fields.step }),
          ...(fields.action === "continued_from_step" ? { copy_id: fields.copyId } : {}),
          ...(fields.action === "reply_edited"
            ? { target: fields.target, target_id: fields.targetId }
            : {}),
        },
      );
    },
  };
}
