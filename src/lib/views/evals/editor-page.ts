import { getDb } from "@/lib/platform/db/client";
import {
  defaultOrganizationFlagDeps,
  type OrganizationFlagDeps,
} from "@/lib/platform/organization-flags";
import { SCORER_KINDS, type ScorerKind } from "@/lib/views/task-scorers/types";
import { createDrizzleEvalStore } from "./adapters/drizzle-store";
import { type EvalForm, fixedAnswerFromStep, formFromEval, limitHint } from "./domain/edit";
import { effectiveScorers } from "./domain/scoring";
import { taskTag } from "./domain/task-name";
import type { Eval } from "./domain/types";
import { evalsEnabledForActor } from "./gate";
import { taskNames } from "./page";
import { enabledTaskScorers } from "./task-scorers";
import { testSteps } from "./test-view";
import type { TaskTag } from "./view";

/**
 * RC-297: what the eval editor reads (`?edit=1`). With `mock`, the step of a
 * run's test view that "Set a fixed answer for this tool" points at is added
 * as a fixed answer, filled in. Null when `cloud-eval-gate` is off for the person
 * or the eval is not in the project.
 */

export interface EvalEditorModel {
  item: Eval;
  form: EvalForm;
  tasks: TaskTag[];
  tools: string[];
  hints: Record<ScorerKind, string | null>;
  /** The index of the fixed answer filled in from a step. */
  mockAt: number | null;
  runCount: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECENT = 50;

export async function loadEvalEditor(
  projectId: string,
  actor: string,
  evalId: string,
  mock: { runId: string; step: number } | null,
  deps: { db?: ReturnType<typeof getDb>; flagDeps?: OrganizationFlagDeps } = {},
): Promise<EvalEditorModel | null> {
  const db = deps.db ?? getDb();
  if (
    !(await evalsEnabledForActor(
      projectId,
      actor,
      db,
      deps.flagDeps ?? defaultOrganizationFlagDeps,
    ))
  )
    return null;
  const store = createDrizzleEvalStore(db);
  const item = UUID.test(evalId) ? await store.getEval(projectId, evalId) : null;
  if (!item) return null;
  const taskIds = [
    ...new Set([
      ...item.tasks,
      ...(await store.listEvals(projectId)).flatMap((other) => other.tasks),
    ]),
  ];
  const [names, scorers, history] = [
    await taskNames(projectId, taskIds, db),
    await enabledTaskScorers(projectId, item.tasks, db),
    await store.resultsForEval(projectId, item.id, RECENT),
  ];
  const taskScorers = item.tasks.map((id) => scorers.get(id) ?? []);
  const form = formFromEval(item, effectiveScorers(taskScorers, item));
  let mockAt: number | null = null;
  const picked = mock ? history.find((entry) => entry.run.id === mock.runId) : undefined;
  const step = picked ? testSteps(picked.result).steps[mock!.step] : undefined;
  if (step?.kind === "tool") {
    mockAt = form.fixedAnswers.length;
    form.fixedAnswers.push(fixedAnswerFromStep(step));
  }
  const tools = new Set<string>();
  for (const { result } of history) {
    for (const tool of result.transcript?.toolsOffered ?? []) tools.add(tool);
    for (const answer of result.toolAnswers) tools.add(answer.tool);
  }
  for (const message of item.earlierMessages) if (message.tool) tools.add(message.tool);
  for (const answer of item.fixedAnswers) tools.add(answer.tool);
  if (item.expectedTool) tools.add(item.expectedTool);
  return {
    item,
    form,
    mockAt,
    runCount: history.length,
    tasks: taskIds.map((id) => taskTag(id, names)).sort((a, b) => a.label.localeCompare(b.label)),
    tools: [...tools].sort(),
    hints: Object.fromEntries(
      SCORER_KINDS.map((kind) => [kind, limitHint(kind, taskScorers.flat())]),
    ) as Record<ScorerKind, string | null>,
  };
}
