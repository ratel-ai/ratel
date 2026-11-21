import { twin } from "../../../index.js";
import { type LabelInput, label, labelDefaults } from "./label.js";

// A structured twin whose params all reach the model call.

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

export default twin("workflow-label", {
  params: {
    model: twin.model(labelDefaults.model),
    system: twin.prompt(labelDefaults.system),
    maxTokens: twin.int(labelDefaults.maxTokens, { min: 50, max: 2000 }),
  },
  input: twin.structured<LabelInput>(LABEL_SCHEMA),
  defaults: labelDefaults,
  example: EXAMPLE,
  run: ({ input, params }) => label(input, params),
});
