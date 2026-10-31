import Anthropic from "@anthropic-ai/sdk";
import { envNumber } from "@/lib/platform/env-number";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";
import {
  type DecideDeps,
  type DecideResult,
  decideProjectWorkflows,
  defaultDecideDeps,
} from "@/lib/readings/trace-signals/workflows/decide-job";
import {
  buildLabelPrompt,
  LABEL_SCHEMA,
  type LabelInput,
  labelInputHash,
  MAX_LABEL_ASKS,
  parseLabel,
} from "@/lib/readings/trace-signals/workflows/label";
import {
  type LabelableWorkflow,
  loadLabelHashes as loadLabelHashesFn,
  loadLatestWorkflows as loadLatestWorkflowsFn,
  loadToolDocs as loadToolDocsFn,
  loadTurnAsks as loadTurnAsksFn,
  loadWorkflowLabels as loadWorkflowLabelsFn,
  saveLabel as saveLabelFn,
} from "@/lib/readings/trace-signals/workflows/label-queries";

/**
 * The `label_workflows` job: name the latest run's workflows with a model,
 * then (when a choice model is configured) place recent captured asks in them
 * (`decide-job.ts`).
 * Only workflows whose input changed since they were last named are sent, at
 * most {@link MAX_LABELS_PER_JOB} per job, so a project pays once per new or
 * changed workflow. Without an API key the job does nothing and the page keeps
 * the tool-order names. One failed call is logged and skipped, never fatal.
 */

export const LABEL_WORKFLOWS_JOB_KIND = "label_workflows";
export const DEFAULT_LABEL_MODEL = "claude-sonnet-5";
export const MAX_LABELS_PER_JOB = Math.floor(envNumber("TRACE_WORKFLOW_MAX_LABELS", 30));
const LABEL_MAX_TOKENS = 400;
const logger = getLogger("trace-signals/label-workflows");

export interface LabelJobDeps {
  model: string;
  complete: ((system: string, user: string) => Promise<string>) | null;
  loadLatestWorkflows: typeof loadLatestWorkflowsFn;
  loadToolDocs: typeof loadToolDocsFn;
  loadTurnAsks: typeof loadTurnAsksFn;
  loadLabelHashes: typeof loadLabelHashesFn;
  saveLabel: typeof saveLabelFn;
  loadWorkflowLabels: typeof loadWorkflowLabelsFn;
  /** The decision step (Phase W3); null skips it. */
  decide: DecideDeps | null;
}

export interface LabelJobResult {
  workflows: number;
  labelled: number;
  failed: number;
  skipped: "no_model" | null;
  decisions: DecideResult | null;
}

/** A structured-output Anthropic completion, or null without an API key. */
export function anthropicLabelComplete(model: string): LabelJobDeps["complete"] {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === "REPLACE_ME") return null;
  const client = new Anthropic({ apiKey });
  return async (system, user) => {
    const msg = await client.messages.create({
      model,
      max_tokens: LABEL_MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { format: { type: "json_schema", schema: LABEL_SCHEMA } },
    });
    if (msg.stop_reason === "refusal")
      throw new Error("workflow label declined by the model's safety filter");
    return msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  };
}

function defaultDeps(): LabelJobDeps {
  const model = process.env.TRACE_WORKFLOW_LABEL_MODEL || DEFAULT_LABEL_MODEL;
  return {
    model,
    complete: anthropicLabelComplete(model),
    loadLatestWorkflows: loadLatestWorkflowsFn,
    loadToolDocs: loadToolDocsFn,
    loadTurnAsks: loadTurnAsksFn,
    loadLabelHashes: loadLabelHashesFn,
    saveLabel: saveLabelFn,
    loadWorkflowLabels: loadWorkflowLabelsFn,
    decide: defaultDecideDeps(),
  };
}

async function inputFor(
  projectId: string,
  workflow: LabelableWorkflow,
  deps: LabelJobDeps,
): Promise<LabelInput> {
  const toolIds = [...new Set([...workflow.typicalOrder, ...workflow.optionalTools])];
  const [tools, asks] = await Promise.all([
    deps.loadToolDocs(projectId, toolIds),
    deps.loadTurnAsks(projectId, workflow.exampleTurnIds.slice(0, MAX_LABEL_ASKS * 2)),
  ]);
  return {
    workflowId: workflow.id,
    typicalOrder: workflow.typicalOrder,
    optionalTools: workflow.optionalTools,
    tools,
    asks: [...new Set(asks)].slice(0, MAX_LABEL_ASKS),
  };
}

async function labelOne(
  projectId: string,
  input: LabelInput,
  hash: string,
  deps: LabelJobDeps & { complete: NonNullable<LabelJobDeps["complete"]> },
): Promise<boolean> {
  try {
    const { system, user } = buildLabelPrompt(input);
    const label = parseLabel(await deps.complete(system, user));
    if (!label) return false;
    await deps.saveLabel(projectId, {
      workflowId: input.workflowId,
      inputHash: hash,
      model: deps.model,
      ...label,
    });
    return true;
  } catch (err) {
    logger.error(
      { err, project_id: projectId, workflow_id: input.workflowId },
      "workflow label failed",
    );
    reportServerException(err, `project:${projectId}`, { operation: "label_workflows" });
    return false;
  }
}

export async function labelProjectWorkflows(
  projectId: string,
  overrides: Partial<LabelJobDeps> = {},
): Promise<LabelJobResult> {
  const deps = { ...defaultDeps(), ...overrides };
  const workflows = await deps.loadLatestWorkflows(projectId);
  const named = await writeLabels(projectId, workflows, deps);
  const decisions = deps.decide
    ? await decideProjectWorkflows(
        projectId,
        workflows,
        await deps.loadWorkflowLabels(projectId),
        deps.decide,
      )
    : null;
  return { workflows: workflows.length, ...named, decisions };
}

async function writeLabels(
  projectId: string,
  workflows: readonly LabelableWorkflow[],
  deps: LabelJobDeps,
): Promise<Pick<LabelJobResult, "labelled" | "failed" | "skipped">> {
  const { complete } = deps;
  if (!complete) return { labelled: 0, failed: 0, skipped: "no_model" };
  const known = await deps.loadLabelHashes(projectId);
  let labelled = 0;
  let failed = 0;
  for (const workflow of workflows) {
    if (labelled + failed >= MAX_LABELS_PER_JOB) break;
    const input = await inputFor(projectId, workflow, deps);
    const hash = labelInputHash(input);
    if (known.get(workflow.id) === hash) continue;
    if (await labelOne(projectId, input, hash, { ...deps, complete })) labelled += 1;
    else failed += 1;
  }
  logger.info(
    { project_id: projectId, workflows: workflows.length, labelled, failed },
    "workflow labels written",
  );
  return { labelled, failed, skipped: null };
}
