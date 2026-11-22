import { sandbox } from "../../../index.js";
import { type LabelInput, label, labelDefaults } from "./label.js";

// A structured sandbox whose params all reach the model call.

export const LABEL_SCHEMA = {
  type: "object",
  required: ["workflowId", "toolOrder"],
  properties: {
    workflowId: { type: "string" },
    toolOrder: { type: "array", items: { type: "string" } },
  },
} as const;

export const EXAMPLE: LabelInput = {
  workflowId: "wf_refunds",
  toolOrder: ["searchDocs", "readDoc"],
};

export default sandbox("workflow-label", {
  params: {
    model: sandbox.model(labelDefaults.model),
    system: sandbox.prompt(labelDefaults.system),
    maxTokens: sandbox.int(labelDefaults.maxTokens, { min: 50, max: 2000 }),
  },
  input: sandbox.structured<LabelInput>(LABEL_SCHEMA),
  defaults: labelDefaults,
  example: EXAMPLE,
  run: ({ input, params }) => label(input, params),
});
