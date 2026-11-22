// Compile-only assertions that the AI SDK path lines up with `ai`'s own types,
// so a drift in the AI SDK surface fails `tsc -p tsconfig.type-tests.json`.
// CI runs it against ai@6 and ai@7 (the sandbox rows of the ai-sdk compat job).
import { type LanguageModel, type ModelMessage, streamText } from "ai";
import { aiSdkChat, aiSdkModels, forwardText } from "./ai-sdk.js";
import { type ModelResolver, sandbox } from "./index.js";

// The resolver hands run() an AI SDK LanguageModel.
const resolve: ModelResolver<LanguageModel> = aiSdkModels();

// A production entry function: the default config holds a model ID string,
// which the AI SDK also accepts as a LanguageModel (global provider).
const defaults = { model: "anthropic/claude-sonnet-5-5", system: "Answer from the docs." };
async function reply(
  messages: ModelMessage[],
  cfg: { model: LanguageModel; system: string } = defaults,
): Promise<string> {
  return streamText({ model: cfg.model, system: cfg.system, messages }).text;
}

export const docs = sandbox("docs-agent", {
  params: { model: sandbox.model(defaults.model), system: sandbox.prompt(defaults.system) },
  input: aiSdkChat(),
  context: sandbox.context({ userId: "demo-user" }),
  resolve,
  // input.messages is ModelMessage[], params.model a LanguageModel: no cast.
  run: async ({ input, params, ctx }) => {
    const messages: ModelMessage[] = input.messages;
    const model: LanguageModel = params.model;
    const result = streamText({ model, system: params.system, messages });
    return forwardText(result.textStream, ctx);
  },
});

void reply;
