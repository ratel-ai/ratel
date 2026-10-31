import type {
  TurnUnit,
  WorkflowStep,
  WorkflowToolCall,
  WorkflowTurn,
} from "@/lib/readings/trace-signals/workflows/types";

/**
 * A turn as workflow mining reads it. Only tool calls count, the same
 * convention as `pairs.ts`: an invoke step with `targetType` "tool" and its
 * catalog id in `targetId`. Skills and searches are left out; a workflow is a
 * statement about the tools an agent strings together.
 */

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

export function turnUnit(turn: Pick<WorkflowTurn, "id" | "steps">): TurnUnit {
  const path = firstCallPath(toolCalls(turn));
  return { turnId: turn.id, tools: [...path].sort(), path };
}
