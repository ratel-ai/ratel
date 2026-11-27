import {
  DEFAULT_EVAL_TRIALS,
  type EvalContent,
  type EvalDefinition,
  type EvalScorer,
} from "./eval";

/**
 * Where "Save as eval case" puts a turn or a run (decision `trace-to-eval`): an eval of its task.
 * One task is the default. With more, the task of the page is the default, else the person
 * chooses one or more, and the turn becomes one row in each chosen eval. A task with one eval saves
 * into it. With more, the person chooses one. A task with no eval gets a new eval with the task's
 * default scorers, which the person confirms. A turn with no task goes to an eval that the person
 * names.
 */

/** A task as the evals module knows it: an id and a name. */
export type TaskRef = { id: string; name: string };

/** The default scorers of a task, in the shape of `task-scorers/types.ts#Scorer`. */
export type TaskScorerInput =
  | { kind: "ends_well" }
  | {
      kind: "max_self_corrections" | "max_latency_ms" | "max_cost_usd" | "max_tool_calls";
      max: number;
    }
  | { kind: "expected_tool"; tool: string }
  | { kind: "judge_criteria"; criteria: string };

export type SaveTarget =
  | { kind: "existing"; evalId: string; name: string; taskId: string | null }
  | { kind: "choose"; taskId: string; evals: Array<{ id: string; name: string }> }
  | { kind: "new"; name: string; taskId: string; content: EvalContent }
  | { kind: "named" };

/** What a new eval of a task starts with. */
export type NewEvalDefaults = { scorers: EvalScorer[]; sandboxName: string | null };

const MAX_SCORER_NAME = 100;

/** The task that the dialog chooses first. Null: the person chooses, or there is no task. */
export function defaultTask(tasks: readonly TaskRef[], pageTaskId: string | null): TaskRef | null {
  if (tasks.length === 1) return tasks[0] ?? null;
  return tasks.find(({ id }) => id === pageTaskId) ?? null;
}

/**
 * The eval of the task, the evals that the person chooses from, or a new eval for the task. With no
 * task, the person names the eval.
 */
export function saveTarget(
  task: TaskRef | null,
  evals: readonly EvalDefinition[],
  defaults: NewEvalDefaults,
): SaveTarget {
  if (!task) return { kind: "named" };
  const found = evals.filter(({ taskId }) => taskId === task.id);
  const [only] = found;
  if (only && found.length === 1) {
    return { kind: "existing", evalId: only.id, name: only.name, taskId: task.id };
  }
  if (found.length > 1) {
    return { kind: "choose", taskId: task.id, evals: found.map(({ id, name }) => ({ id, name })) };
  }
  return {
    kind: "new",
    name: freeName(task.name, evals),
    taskId: task.id,
    content: {
      sandboxName: defaults.sandboxName,
      params: {},
      trials: DEFAULT_EVAL_TRIALS,
      scorers: defaults.scorers,
    },
  };
}

/**
 * The default scorers of a task as scorers of an eval. A trial has no measure of a good end, of
 * self-corrections or of the number of tool calls: those are left out.
 */
export function scorersOfTask(scorers: readonly TaskScorerInput[]): EvalScorer[] {
  return scorers.flatMap((scorer): EvalScorer[] => {
    const id = `task-${scorer.kind}`;
    switch (scorer.kind) {
      case "expected_tool":
        return [check(id, `Calls ${scorer.tool}`, "tools", "contains", scorer.tool)];
      case "max_latency_ms":
        return [check(id, `At most ${scorer.max} ms`, "duration_ms", "lte", scorer.max)];
      case "max_cost_usd":
        return [check(id, `At most $${scorer.max}`, "cost_usd", "lte", scorer.max)];
      case "judge_criteria":
        return [
          {
            id,
            name: scorer.criteria.slice(0, MAX_SCORER_NAME),
            gating: true,
            definition: { kind: "judge", config: { prompt: scorer.criteria, output: "boolean" } },
          },
        ];
      default:
        return [];
    }
  });
}

function check(
  id: string,
  name: string,
  path: string,
  op: "contains" | "lte",
  value: string | number,
): EvalScorer {
  return { id, name, gating: true, definition: { kind: "check", config: { path, op, value } } };
}

/** The name, or the name with the first number that no eval has. */
function freeName(name: string, evals: readonly Pick<EvalDefinition, "name">[]): string {
  const taken = new Set(evals.map((one) => one.name));
  if (!taken.has(name)) return name;
  for (let n = 2; ; n += 1) if (!taken.has(`${name} ${n}`)) return `${name} ${n}`;
}
