import type {
  TurnUnit,
  WorkflowStep,
  WorkflowToolCall,
  WorkflowTurn,
} from "@/lib/readings/trace-signals/workflows/types";

/**
 * A turn as workflow mining reads it: its items in first-occurrence order.
 *
 * - Flag off: only tool calls count, the same convention as `pairs.ts`: an
 *   invoke step with `targetType` "tool" and its catalog id in `targetId`.
 *   Skills, searches and typed steps are left out.
 * - `cloud-typed-steps` on (RC-1072): typed steps and skills are items too,
 *   as tokens. A tool keeps its bare id, so tool-only task ids do not change;
 *   a skill is `skill:<id>`, a model call `model:<signature token>`, a code
 *   step `code:<name>`, a handoff `handoff:<agent>`. A user message is a
 *   boundary, never an item.
 *
 * A unit forms a task with two distinct tools, or with one token when any
 * token is not a tool ({@link formsTask}): a run of model calls alone is a task.
 */

export interface UnitOptions {
  /** `cloud-typed-steps`: read typed steps and skills as tokens. */
  typedSteps?: boolean;
}

/** Distinct tools a tool-only unit needs to form a task. */
export const MIN_TOOL_ITEMS = 2;

const TYPED_PREFIX = {
  model_call: "model",
  code: "code",
  handoff: "handoff",
} as const;

export function turnUnit(
  turn: Pick<WorkflowTurn, "id" | "steps">,
  options: UnitOptions = {},
): TurnUnit {
  return stepsUnit(turn.id, turn.steps, options);
}

/** The unit of a step list: a whole turn's steps, or one piece of them. */
export function stepsUnit(
  turnId: string,
  steps: readonly WorkflowStep[],
  options: UnitOptions = {},
): TurnUnit {
  const items = taskSteps({ steps }, options);
  const path = firstCallPath(items);
  const nonTools = new Set(
    items
      .filter((step) => !(step.kind === "invoke" && step.targetType === "tool"))
      .map((step) => step.targetId),
  );
  return { turnId, tools: [...path].sort(), path, nonTools: [...nonTools].sort() };
}

/** Whether a unit is a task candidate: two distinct tools, or one token when any token is not a tool. */
export function formsTask(unit: Pick<TurnUnit, "tools" | "nonTools">): boolean {
  return unit.nonTools.length > 0 || unit.tools.length >= MIN_TOOL_ITEMS;
}

/**
 * The turn's items in step order, each with its token in `targetId`: tool
 * calls only with the flag off, every token-bearing step with it on.
 */
export function taskSteps(
  turn: Pick<WorkflowTurn, "steps">,
  options: UnitOptions = {},
): WorkflowToolCall[] {
  if (!options.typedSteps) return toolCalls(turn);
  return turn.steps.flatMap((step) => {
    const token = stepToken(step);
    return token === null ? [] : [{ ...step, targetId: token } as WorkflowToolCall];
  });
}

/** The turn's tool calls in step order (skills and searches dropped). */
export function toolCalls(turn: Pick<WorkflowTurn, "steps">): WorkflowToolCall[] {
  return turn.steps.filter(isToolCall);
}

/** Same test as `isInvoke` in `turn-facts.ts`, narrowed to tools. */
export function isToolCall(step: WorkflowStep): step is WorkflowToolCall {
  return step.kind === "invoke" && step.targetType === "tool" && step.targetId !== null;
}

/** Distinct tool ids in the order each was first called. */
export function firstCallPath(calls: readonly Pick<WorkflowToolCall, "targetId">[]): string[] {
  const seen = new Set<string>();
  const path: string[] = [];
  for (const call of calls) {
    if (seen.has(call.targetId)) continue;
    seen.add(call.targetId);
    path.push(call.targetId);
  }
  return path;
}

/** A step's token with the flag on; null for a step that is no item (a search, a user message, an agent run). */
export function stepToken(step: WorkflowStep): string | null {
  if (!step.targetId) return null;
  if (isToolCall(step)) return step.targetId;
  if (step.kind === "invoke" && step.targetType === "skill") return `skill:${step.targetId}`;
  if (step.kind === "model_call" || step.kind === "code" || step.kind === "handoff")
    return `${TYPED_PREFIX[step.kind]}:${step.targetId}`;
  return null;
}
