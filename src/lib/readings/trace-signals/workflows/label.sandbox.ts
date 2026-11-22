import { sandbox } from "@ratel-ai/sandbox";
import {
  buildLabelPrompt,
  LABEL_SANDBOX_ID,
  type LabelInput,
  labelDefaults,
  MAX_LABEL_ASKS,
  parseLabel,
  type WorkflowLabel,
} from "@/lib/readings/trace-signals/workflows/label";
import { anthropicLabelComplete } from "@/lib/readings/trace-signals/workflows/label-job";

/**
 * The `workflow-label` sandbox (spec §3.1, RC-1091): the `label_workflows` job's
 * one item, one {@link LabelInput} in and one label out, with the model, the
 * system prompt and the output budget as params. `ratel sandbox run` and
 * `ratel sandbox dev` load it; no production code imports it.
 *
 *   ratel sandbox run workflow-label --input lib/trace-signals/workflows/label.sandbox.input.json --set maxTokens=200
 */

const STRINGS = { type: "array", items: { type: "string" } } as const;

/** JSON Schema of {@link LabelInput}. */
export const LabelInputSchema = {
  type: "object",
  required: ["workflowId", "typicalOrder", "optionalTools", "tools", "asks"],
  additionalProperties: false,
  properties: {
    workflowId: { type: "string" },
    typicalOrder: STRINGS,
    optionalTools: STRINGS,
    tools: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "name", "description"],
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
        },
      },
    },
    asks: { ...STRINGS, maxItems: MAX_LABEL_ASKS },
  },
} as const;

export default sandbox(LABEL_SANDBOX_ID, {
  params: {
    model: sandbox.model(labelDefaults.model),
    system: sandbox.prompt(labelDefaults.system),
    maxTokens: sandbox.int(labelDefaults.maxTokens, { min: 50, max: 2000 }),
  },
  input: sandbox.structured<LabelInput>(LabelInputSchema),
  // The ctx.log lines stream to the playground as `log` events. They carry
  // counts and the model id only, never the asks or the answer.
  run: async ({ input, params, ctx }): Promise<WorkflowLabel | null> => {
    const complete = anthropicLabelComplete(params);
    if (!complete)
      throw new Error("no Claude backend: set ANTHROPIC_API_KEY (or ANTHROPIC_BACKEND=bedrock)");
    const { user } = buildLabelPrompt(input);
    ctx.log(`prompt built: ${input.tools.length} tools, ${input.asks.length} asks`);
    const answer = await complete(params.system, user);
    ctx.log(`model ${params.model} answered`);
    const label = parseLabel(answer);
    ctx.log(label ? "label parsed" : "no label in the answer", label ? "info" : "warn");
    return label;
  },
});
