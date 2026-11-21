import { type LanguageModel, type ModelMessage, streamText } from "ai";
import { aiSdkChat, type aiSdkModels, forwardText } from "../ai-sdk.js";
import { twin } from "../index.js";
import type { RunContext } from "../twin.js";

// A chat twin on the AI SDK path, as a user would write it: production
// `reply(messages, cfg)` takes the conversation and the config, and the twin
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

export function docsTwin(resolve: ReturnType<typeof aiSdkModels>) {
  return twin("docs-agent", {
    params: {
      model: twin.model(docsDefaults.model),
      system: twin.prompt(docsDefaults.system),
    },
    input: aiSdkChat(),
    context: twin.context({ userId: "demo-user" }),
    resolve,
    run: ({ input, params, ctx }) => reply(input.messages, params, ctx),
  });
}
