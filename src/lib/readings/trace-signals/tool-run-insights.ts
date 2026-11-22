import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { toolRunInsightsOn } from "@/lib/platform/tool-run-insights-flag";
import { typedStepsEnabled } from "./typed-steps";
import type { WorkflowConfig } from "./workflows/types";

/**
 * `cloud-tool-run-insights` (RC-725): dogfooding fixes so Tasks read
 * tool-only runs, such as an MCP server's own tool calls.
 * Off, Tasks read as before.
 *
 * - Tasks: mining uses {@link TOOL_RUN_MINING}. The default support floor
 *   (10 runs that hold the same tools) hides every task of a project with a
 *   few dozen multi-tool runs; "Beluga - MCP" had 18 and no task.
 * - Intents (RC-743): a tool-only turn with no ask reads a derived ask, its
 *   task's name or its tool path (`topics/derived-asks.ts`).
 * - Agent runs (RC-742): ingest writes an `agent_run` row per OTel
 *   `invoke_agent` root span (`otlp/derive-agent-runs.ts`), and the turn build
 *   reads those rows (`turns/build-job.ts`), so a run of model calls with no
 *   tool call (the platform's own backend jobs) makes one turn whose ask is the
 *   root's.
 * - Agent tasks (RC-747): those tool-less agent runs make one task per agent
 *   at the same floor of three (`workflows/agent-tasks.ts`), named from the
 *   agent ("draft_fix" reads "Draft fix") until the labeller names it from
 *   its asks.
 *
 * Owned (ADR-0030): the switch is the core's `FF_TOOL_RUN_INSIGHTS`
 * (`lib/platform/tool-run-insights-flag.ts`), off by default: the environment
 * without the edition's flags port, else the edition decides it for the
 * project and organization, after any `FF_*` value the operator set.
 * The functions keep upstream's names and arguments, so every caller stays
 * upstream's; the last argument is the environment instead of the flag deps.
 */

type Env = Record<string, string | undefined>;

/**
 * The mining config of a project with the flag on: three runs make a task,
 * and tool-less agent runs make one task per agent (RC-747).
 */
export const TOOL_RUN_MINING: Readonly<Partial<WorkflowConfig>> = Object.freeze({
  minSupport: 3,
  agentTasks: true,
});

/** Whether the flag is on for the project (and its organization, when known). Never throws: a failed decision is off. */
export async function toolRunInsightsEnabled(
  projectId: string,
  organization?: unknown,
  env: Env = process.env,
): Promise<boolean> {
  const organizationId = organizationIdOf(organization);
  return toolRunInsightsOn(organizationId ? { projectId, organizationId } : { projectId }, { env });
}

/** The flag for a project. Never throws. */
export async function toolRunInsightsForProject(
  projectId: string,
  env: Env = process.env,
): Promise<boolean> {
  return toolRunInsightsEnabled(projectId, undefined, env);
}

/**
 * The mining config for the project's signal run: {@link TOOL_RUN_MINING} with
 * the flag on, plus `typedSteps` with `cloud-typed-steps` (`FF_TYPED_STEPS`) on
 * (RC-1072); null (the defaults) with both off.
 */
export async function workflowMiningFor(
  projectId: string,
  organization?: unknown,
  env: Env = process.env,
): Promise<Partial<WorkflowConfig> | null> {
  return withFeatureSpan(
    "tool_run_insights",
    "mining_config",
    async (span) => {
      const [enabled, typedSteps] = await Promise.all([
        toolRunInsightsEnabled(projectId, organization, env),
        typedStepsEnabled(projectId, organization, env),
      ]);
      span.setAttribute("tool_run_insights.enabled", enabled);
      if (!typedSteps) return enabled ? TOOL_RUN_MINING : null;
      return { ...(enabled ? TOOL_RUN_MINING : {}), typedSteps: true };
    },
    { attributes: { "project.id": projectId } },
  );
}

/** The organization's id when the caller passed one (upstream passes its organization record). */
function organizationIdOf(organization: unknown): string | undefined {
  if (typeof organization !== "object" || organization === null || !("id" in organization)) {
    return undefined;
  }
  return typeof organization.id === "string" ? organization.id : undefined;
}
