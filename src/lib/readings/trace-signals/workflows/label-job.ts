import type Anthropic from "@anthropic-ai/sdk";
import type { Attributes } from "@opentelemetry/api";
import { bareModelId } from "@ratel-ai/sandbox";
import { envNumber } from "@/lib/platform/env-number";
import { getLogger } from "@/lib/platform/logger";
import { anthropicUsage, recordModelCall, trackModelCall } from "@/lib/platform/model-call";
import { anthropicContent } from "@/lib/platform/model-call-content";
import { reportServerException } from "@/lib/platform/telemetry";
import { anthropicClient } from "@/lib/readings/anthropic/client";
import { sandboxInputAttributes, stampSandboxConfig } from "@/lib/readings/sandboxes/stamps";
import { wellFormedJson } from "@/lib/readings/text/well-formed";
import {
  type DecideDeps,
  type DecideResult,
  decideProjectWorkflows,
  defaultDecideDeps,
} from "@/lib/readings/trace-signals/workflows/decide-job";
import {
  buildLabelPrompt,
  LABEL_SANDBOX_ID,
  LABEL_SCHEMA,
  type LabelConfig,
  type LabelInput,
  labelDefaults,
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
/** The bare model ID of {@link labelDefaults}, for the raw Anthropic client. */
export const DEFAULT_LABEL_MODEL = bareModelId(labelDefaults.model);
export const MAX_LABELS_PER_JOB = Math.floor(envNumber("TRACE_WORKFLOW_MAX_LABELS", 30));
const logger = getLogger("trace-signals/label-workflows");

export interface LabelJobDeps {
  model: string;
  /** The resolved config the job runs with; {@link labelDefaults} when absent. */
  config?: LabelConfig;
  /**
   * `FF_SANDBOXES` for the project (RC-1091): stamp the `workflow-label` sandbox on
   * the run's root and each item's span, and key the cache on its config hash.
   * Off when absent.
   */
  sandbox?: boolean;
  /** `spanAttributes` ride the call's model-call span only. */
  complete: ((system: string, user: string, spanAttributes?: Attributes) => Promise<string>) | null;
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

/** What one label call sends: the bare model ID and the output budget. */
export interface LabelCallConfig {
  model: string;
  maxTokens: number;
}

/** A structured-output Anthropic completion, or null without a Claude backend. */
export function anthropicLabelComplete({
  model,
  maxTokens,
}: LabelCallConfig): LabelJobDeps["complete"] {
  const client = anthropicClient();
  if (!client) return null;
  return async (system, user, spanAttributes) => {
    const request: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { format: { type: "json_schema", schema: LABEL_SCHEMA } },
    };
    const msg = await trackModelCall(
      {
        provider: "anthropic",
        model,
        feature: "workflow_label",
        payer: "ratel",
        content: anthropicContent(request),
        spanAttributes,
      },
      () => client.messages.create(wellFormedJson(request)),
      anthropicUsage,
    );
    if (msg.stop_reason === "refusal")
      throw new Error("workflow label declined by the model's safety filter");
    return msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  };
}

function defaultDeps(): LabelJobDeps {
  const config = labelConfigFromEnv();
  const model = bareModelId(config.model);
  return {
    model,
    config,
    complete: anthropicLabelComplete({ model, maxTokens: config.maxTokens }),
    loadLatestWorkflows: loadLatestWorkflowsFn,
    loadToolDocs: loadToolDocsFn,
    loadTurnAsks: loadTurnAsksFn,
    loadLabelHashes: loadLabelHashesFn,
    saveLabel: saveLabelFn,
    loadWorkflowLabels: loadWorkflowLabelsFn,
    decide: defaultDecideDeps(),
  };
}

/** {@link labelDefaults}, with `TRACE_WORKFLOW_LABEL_MODEL` as its Anthropic model when set. */
function labelConfigFromEnv(): LabelConfig {
  const model = process.env.TRACE_WORKFLOW_LABEL_MODEL;
  return model ? { ...labelDefaults, model: `anthropic/${model}` } : labelDefaults;
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
    const { user } = buildLabelPrompt(input);
    const system = (deps.config ?? labelDefaults).system;
    const label = parseLabel(
      await deps.complete(system, user, deps.sandbox ? sandboxInputAttributes(input) : undefined),
    );
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
  const configHash = deps.sandbox
    ? stampSandboxConfig(deps.config ?? labelDefaults, { sandbox: LABEL_SANDBOX_ID })
    : null;
  const workflows = await deps.loadLatestWorkflows(projectId);
  const named = await writeLabels(projectId, workflows, deps, configHash);
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
  configHash: string | null,
): Promise<Pick<LabelJobResult, "labelled" | "failed" | "skipped">> {
  const { complete } = deps;
  if (!complete) {
    if (workflows.length > 0) {
      recordModelCall({
        provider: "anthropic",
        model: deps.model,
        feature: "workflow_label",
        payer: "ratel",
        outcome: "skipped_no_key",
        durationMs: 0,
      });
    }
    return { labelled: 0, failed: 0, skipped: "no_model" };
  }
  const known = await deps.loadLabelHashes(projectId);
  let labelled = 0;
  let failed = 0;
  for (const workflow of workflows) {
    if (labelled + failed >= MAX_LABELS_PER_JOB) break;
    const input = await inputFor(projectId, workflow, deps);
    const hash = labelInputHash(input, configHash);
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
