import { sandbox } from "../index.js";

export const labelDefaults = {
  model: "anthropic/claude-sonnet-5-5",
  system: "You name agent workflows.",
  maxTokens: 400,
};

export interface LabelInput {
  workflowId: string;
  toolOrder: string[];
}

export const labelSandbox = sandbox("workflow-label", {
  params: {
    model: sandbox.model(labelDefaults.model),
    system: sandbox.prompt(labelDefaults.system),
    maxTokens: sandbox.int(labelDefaults.maxTokens, { min: 50, max: 2000 }),
  },
  input: sandbox.structured<LabelInput>({
    type: "object",
    required: ["workflowId", "toolOrder"],
    properties: {
      workflowId: { type: "string" },
      toolOrder: { type: "array", items: { type: "string" } },
    },
  }),
  run: async ({ input, params }) => ({
    name: `${input.workflowId}:${params.model}:${params.maxTokens}`,
    system: params.system,
  }),
});
