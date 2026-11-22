import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { createDrizzleEvalStore } from "./adapters/drizzle-store";
import {
  earlierFromSteps,
  openingWithReply,
  parseReply,
  stepCall,
  withStepAnswer,
} from "./domain/steps";
import type { Eval, EvalResult, EvalRun } from "./domain/types";
import { type ActionResult, queueEvalRun } from "./run";

/**
 * RC-641: change an eval at one step of a run and simulate it again. The
 * caller has checked membership and `cloud-eval-gate` (the server actions in
 * `edit.ts`, the MCP in `lib/mcp/operations/evals`). Steps are the indexes of
 * the run's transcript.
 */

type Db = ReturnType<typeof getDb>;

export interface StepRef {
  evalId: string;
  runId: string;
  step: number;
}

export const NO_EVAL_ERROR = "No eval in this project has that ID.";
export const NO_STEPS_ERROR = "That run of this eval kept no steps.";
const logger = getLogger("evals/steps");

/** Save `answer` as the fixed answer of the call at the step: that tool, with the step's arguments as the condition. */
export async function setStepAnswer(
  projectId: string,
  actor: string,
  ref: StepRef,
  answer: string,
  db: Db = getDb(),
): Promise<ActionResult<Eval>> {
  if (!answer.trim()) return { ok: false, error: "Write the answer the tool gives." };
  const found = await evalAndResult(projectId, ref, db);
  if (!found.ok) return found;
  const { item, result } = found.value;
  const call = stepCall(result.transcript!.steps, ref.step);
  if (!call) return { ok: false, error: `Step ${ref.step} is not a tool answer.` };
  const fixedAnswers = withStepAnswer(
    item.fixedAnswers,
    call,
    answer,
    "Set at a step of a simulated run",
  );
  const updated = await createDrizzleEvalStore(db).updateEval(projectId, item.id, {
    ...patchOf(item),
    fixedAnswers,
  });
  if (!updated) return { ok: false, error: NO_EVAL_ERROR };
  logger.info(
    {
      project_id: projectId,
      eval_id: item.id,
      run_id: ref.runId,
      step: ref.step,
      tool: call.tool,
      actor,
    },
    "eval step answer set",
  );
  return { ok: true, value: updated };
}

/** Queue one manual run of this eval. A manual run that is live already comes back with `created` false. */
export async function rerunEval(
  projectId: string,
  actor: string,
  evalId: string,
  db: Db = getDb(),
): Promise<ActionResult<{ run: EvalRun; created: boolean }>> {
  const item = await createDrizzleEvalStore(db).getEval(projectId, evalId);
  if (!item || item.status === "archived") return { ok: false, error: NO_EVAL_ERROR };
  return queueEvalRun(projectId, actor, null, db, "manual", undefined, {
    id: item.id,
    name: item.name,
  });
}

/**
 * Save a copy of the eval with the run's steps 0..`step` after its earlier
 * messages, then queue a run of the copy. The copy keeps the ask, the spec,
 * the fixed answers and the tasks.
 */
export async function continueFromStep(
  projectId: string,
  actor: string,
  ref: StepRef,
  db: Db = getDb(),
): Promise<ActionResult<{ item: Eval; run: EvalRun; created: boolean }>> {
  const found = await evalAndResult(projectId, ref, db);
  if (!found.ok) return found;
  const { item, result } = found.value;
  const steps = result.transcript!.steps;
  if (!Number.isInteger(ref.step) || ref.step < 0 || ref.step >= steps.length)
    return { ok: false, error: `The run has steps 0 to ${steps.length - 1}.` };
  const copy = await createDrizzleEvalStore(db).createEval({
    projectId,
    name: `${item.name} (continued)`.slice(0, 200),
    message: item.message,
    origin: "user",
    createdBy: actor,
    status: "approved",
    sourceTurnId: item.sourceTurnId,
    earlierMessages: [...item.earlierMessages, ...earlierFromSteps(steps, ref.step)],
    turns: item.turns,
    checks: item.checks,
    expectedTool: item.expectedTool,
    criteria: item.criteria,
    fixedAnswers: item.fixedAnswers,
    tasks: item.tasks,
    ...(item.systemPrompt !== undefined ? { systemPrompt: item.systemPrompt } : {}),
    ...(item.tools !== undefined ? { tools: item.tools } : {}),
    ...(item.context !== undefined ? { context: item.context } : {}),
    ...(item.generated !== undefined ? { generated: item.generated } : {}),
    ...(item.edited !== undefined ? { edited: item.edited } : {}),
  });
  const queued = await queueEvalRun(projectId, actor, null, db, "manual", undefined, {
    id: copy.id,
    name: copy.name,
  });
  if (!queued.ok) return queued;
  logger.info(
    {
      project_id: projectId,
      eval_id: item.id,
      copy_id: copy.id,
      run_id: queued.value.run.id,
      step: ref.step,
      actor,
    },
    "eval continued from step",
  );
  return { ok: true, value: { item: copy, ...queued.value } };
}

/** RC-654: where an edited reply goes: this eval, or a copy of it. */
export type ReplyTarget = "this" | "copy";

/**
 * RC-654: a person edits the agent reply at `step` of a run. The run's steps
 * before it and the edited reply (its text and calls) become the eval's
 * opening: the steps its runs start with after the ask. They go on this eval
 * or on a copy (which keeps the ask, the spec, the answers, the tasks and the
 * run settings); then one run of it is queued.
 */
export async function editReplyAndRerun(
  projectId: string,
  actor: string,
  ref: StepRef,
  input: unknown,
  target: ReplyTarget,
  db: Db = getDb(),
): Promise<ActionResult<{ item: Eval; run: EvalRun; created: boolean }>> {
  const reply = parseReply(input);
  if (!reply.ok) return reply;
  const found = await evalAndResult(projectId, ref, db);
  if (!found.ok) return found;
  const { item, result } = found.value;
  if (item.turns.length > 0)
    return { ok: false, error: "Edit reply works on evals with one turn." };
  const opening = openingWithReply(result.transcript!.steps, ref.step, reply.value);
  if (!opening.ok) return opening;
  const store = createDrizzleEvalStore(db);
  const saved =
    target === "this"
      ? await store.setEvalOpening(projectId, item.id, opening.value)
      : await store.createEval({
          projectId,
          name: `${item.name} (edited reply)`.slice(0, 200),
          message: item.message,
          origin: "user",
          createdBy: actor,
          status: "approved",
          sourceTurnId: item.sourceTurnId,
          earlierMessages: item.earlierMessages,
          turns: item.turns,
          checks: item.checks,
          expectedTool: item.expectedTool,
          criteria: item.criteria,
          fixedAnswers: item.fixedAnswers,
          tasks: item.tasks,
          opening: opening.value,
          ...(item.systemPrompt !== undefined ? { systemPrompt: item.systemPrompt } : {}),
          ...(item.tools !== undefined ? { tools: item.tools } : {}),
          ...(item.context !== undefined ? { context: item.context } : {}),
          ...(item.generated !== undefined ? { generated: item.generated } : {}),
          ...(item.edited !== undefined ? { edited: item.edited } : {}),
          ...(item.runSettings !== undefined ? { runSettings: item.runSettings } : {}),
        });
  if (!saved) return { ok: false, error: NO_EVAL_ERROR };
  const queued = await queueEvalRun(projectId, actor, null, db, "manual", undefined, {
    id: saved.id,
    name: saved.name,
  });
  if (!queued.ok) return queued;
  logger.info(
    {
      project_id: projectId,
      eval_id: item.id,
      target_id: saved.id,
      target,
      run_id: queued.value.run.id,
      step: ref.step,
      calls: reply.value.calls.length,
      actor,
    },
    "eval reply edited",
  );
  return { ok: true, value: { item: saved, ...queued.value } };
}

/** The eval and its result in the run, when the result kept its steps. */
async function evalAndResult(
  projectId: string,
  ref: StepRef,
  db: Db,
): Promise<ActionResult<{ item: Eval; result: EvalResult }>> {
  const store = createDrizzleEvalStore(db);
  const item = await store.getEval(projectId, ref.evalId);
  if (!item || item.status === "archived") return { ok: false, error: NO_EVAL_ERROR };
  const result = (await store.listResults(projectId, ref.runId)).find(
    (row) => row.evalId === item.id && row.side === "before",
  );
  if (!result?.transcript) return { ok: false, error: NO_STEPS_ERROR };
  return { ok: true, value: { item, result } };
}

function patchOf(item: Eval) {
  return {
    name: item.name,
    earlierMessages: item.earlierMessages,
    turns: item.turns,
    tasks: item.tasks,
    checks: item.checks,
    expectedTool: item.expectedTool,
    criteria: item.criteria,
    fixedAnswers: item.fixedAnswers,
  };
}
