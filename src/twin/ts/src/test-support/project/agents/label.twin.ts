import { twin } from "../../../index.js";
import { type LabelInput, label, labelDefaults } from "./label.js";

export default twin("workflow-label", {
  params: {
    model: twin.model(labelDefaults.model),
    system: twin.prompt(labelDefaults.system),
    maxTokens: twin.int(labelDefaults.maxTokens, { min: 50, max: 2000 }),
  },
  input: twin.structured<LabelInput>({
    type: "object",
    required: ["workflowId", "toolOrder"],
    properties: {
      workflowId: { type: "string" },
      toolOrder: { type: "array", items: { type: "string" } },
    },
  }),
  run: async ({ input, params }) => ({
    ...(await label(input, params)),
    greeting: process.env.TWIN_FIXTURE_GREETING ?? null,
    pid: process.pid,
    ppid: process.ppid,
  }),
});
