import { twin } from "../../../index.js";
import { type LabelInput, label, labelDefaults } from "./label.js";
import { EXAMPLE, LABEL_SCHEMA } from "./label.twin.js";

// A twin that declares a prompt param its run ignores: verify must name it.

export default twin("label-ignores-prompt", {
  params: {
    model: twin.model(labelDefaults.model),
    system: twin.prompt(labelDefaults.system),
    maxTokens: twin.int(labelDefaults.maxTokens, { min: 50, max: 2000 }),
  },
  input: twin.structured<LabelInput>(LABEL_SCHEMA),
  defaults: labelDefaults,
  example: EXAMPLE,
  run: ({ input, params }) => label(input, { ...params, system: labelDefaults.system }),
});
