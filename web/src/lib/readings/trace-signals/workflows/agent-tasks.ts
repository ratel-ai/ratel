import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";
import { deriveWorkflow } from "@/lib/readings/trace-signals/workflows/derive";
import {
  DEFAULT_WORKFLOW_CONFIG,
  type Workflow,
  type WorkflowTurn,
} from "@/lib/readings/trace-signals/workflows/types";
import { turnUnit } from "@/lib/readings/trace-signals/workflows/units";

/**
 * Tasks of tool-less agent runs (RC-747, `cloud-tool-run-insights`). An agent
 * run that calls no tool (an OTLP `invoke_agent` root, RC-742; Ratel's
 * own backend jobs) has one `agent` step whose target id is the agent's name.
 * Tool mining needs two tools, so such runs formed no task. Here the runs of
 * one agent form one task once there are `minSupport` of them.
 *
 * The task reads like any other: its one step is the agent, as a synthetic
 * tool id (`agent:<name>`), so health, the step reading, placement, ids and
 * the labeller need no new shape, and a stored reading parses as before. The
 * labeller names it from its runs' asks; until then the name is the agent's,
 * made readable ({@link agentTaskName}).
 */

export const AGENT_STEP_PREFIX = "agent:";

/** The agent tasks of a signal run, and how many agent runs they were read from. */
export interface AgentTasks {
  workflows: Workflow[];
  /** Agent runs read: what an agent task's `share` is of. */
  runs: number;
}

/** One task per agent with at least `minSupport` runs, most runs first, then by id. */
export function agentWorkflows(runs: readonly WorkflowTurn[], minSupport: number): AgentTasks {
  const byAgent = new Map<string, WorkflowTurn[]>();
  for (const run of runs) {
    const id = run.steps[0]?.targetId;
    if (!id) continue;
    byAgent.set(id, [...(byAgent.get(id) ?? []), run]);
  }
  const ctx = {
    ubiquitous: new Map<string, number>(),
    turnsWithTools: runs.length,
    config: DEFAULT_WORKFLOW_CONFIG,
  };
  const workflows = [...byAgent]
    .filter(([, members]) => members.length >= minSupport)
    .map(([id, members]) =>
      deriveWorkflow({ tools: [id], support: members.length }, members.map(turnUnit), ctx),
    )
    .sort((a, b) => b.runs - a.runs || (a.coreTools[0]! < b.coreTools[0]! ? -1 : 1));
  return { workflows, runs: runs.length };
}

/** The step id an agent's runs read as: `agent:<name>`. */
export function agentStepId(agent: string): string {
  return `${AGENT_STEP_PREFIX}${agent}`;
}

/**
 * The run as an agent task reads it: its agent step as one call of the
 * synthetic tool `agent:<name>`. Null for a run with no named agent step.
 * Call it only for a run that called no tool (`compactTurn` gave null).
 */
export function compactAgentRun(turn: SignalTurn): WorkflowTurn | null {
  const step = turn.steps.find((candidate) => candidate.kind === "agent" && candidate.targetId);
  if (!step?.targetId) return null;
  return {
    id: turn.id,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    turnSource: turn.turnSource,
    steps: [
      {
        kind: "invoke",
        targetType: "tool",
        targetId: agentStepId(step.targetId),
        outcome: step.outcome,
        tookMs: step.tookMs,
        traceEventId: step.traceEventId,
        handoffMs: null,
      },
    ],
  };
}

/** Whether a step id is an agent's (`agent:<name>`). */
export function isAgentStepId(id: string): boolean {
  return id.startsWith(AGENT_STEP_PREFIX) && id.length > AGENT_STEP_PREFIX.length;
}

/**
 * A readable name for an agent step id, made without a model: the agent's
 * name in sentence case, words split at `_`, `-`, `.` and camel case
 * ("agent:draft_fix" reads "Draft fix"). Null for any other id.
 */
export function agentTaskName(id: string): string | null {
  if (!isAgentStepId(id)) return null;
  const words = id
    .slice(AGENT_STEP_PREFIX.length)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
  if (words.length === 0) return null;
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
