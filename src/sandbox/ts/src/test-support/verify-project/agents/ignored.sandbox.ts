import { sandbox } from "../../../index.js";
import { type LabelInput, label, labelDefaults } from "./label.js";
import { EXAMPLE, LABEL_SCHEMA } from "./label.sandbox.js";

// A sandbox that declares a prompt param its run ignores: verify must name it.

export default sandbox("label-ignores-prompt", {
  params: {
    model: sandbox.model(labelDefaults.model),
    system: sandbox.prompt(labelDefaults.system),
    maxTokens: sandbox.int(labelDefaults.maxTokens, { min: 50, max: 2000 }),
  },
  input: sandbox.structured<LabelInput>(LABEL_SCHEMA),
  defaults: labelDefaults,
  example: EXAMPLE,
  run: ({ input, params }) => label(input, { ...params, system: labelDefaults.system }),
});
