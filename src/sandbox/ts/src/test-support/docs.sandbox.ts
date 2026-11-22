import { type LanguageModel, type ModelMessage, streamText } from "ai";
import { aiSdkChat, type aiSdkModels, forwardText } from "../ai-sdk.js";
import { sandbox } from "../index.js";
import type { RunContext } from "../sandbox.js";

// A chat sandbox on the AI SDK path, as a user would write it: production
// `reply(messages, cfg)` takes the conversation and the config, and the sandbox
// passes the resolved model in. Build-excluded.

export const docsDefaults = {
  model: "anthropic/claude-sonnet-5-5",
  system: "You answer questions about the Ratel docs.",
};

export interface ReplyConfig {
  readonly model: LanguageModel;
  readonly system: string;
}

export async function reply(
  messages: ModelMessage[],
  cfg: ReplyConfig,
  ctx?: Pick<RunContext, "textDelta">,
): Promise<string> {
  const result = streamText({ model: cfg.model, system: cfg.system, messages });
  return ctx ? forwardText(result.textStream, ctx) : result.text;
}

export function docsSandbox(resolve: ReturnType<typeof aiSdkModels>) {
  return sandbox("docs-agent", {
    params: {
      model: sandbox.model(docsDefaults.model),
      system: sandbox.prompt(docsDefaults.system),
    },
    input: aiSdkChat(),
    context: sandbox.context({ userId: "demo-user" }),
    resolve,
    run: ({ input, params, ctx }) => reply(input.messages, params, ctx),
  });
}
