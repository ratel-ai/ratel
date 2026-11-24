import type { AuthClient } from "google-auth-library";
import type { ModelContext, ModelProviderAdapter } from "../index";
import { isClaudeModel, type VendorName } from "../vendors";
import { anthropicProvider, claudeOn } from "./anthropic";
import { chatCompletions, type Dialect } from "./chat-completions";
import { type ClaudeHostOptions, vertexHost } from "./claude-hosts";
import { awsSigned, googleToken } from "./cloud-auth";
import type { HttpOptions } from "./http";
import { responses } from "./responses";

/** Which adapter serves each vendor, and what each vendor does its own way (ADR-0009 §3). */

export interface ProviderOptions extends HttpOptions {
  googleAuth?: () => Promise<AuthClient>;
  awsKeys?: ClaudeHostOptions["awsKeys"];
}

/** OpenAI's reasoning families: GPT-5 and later, and the o-series. */
const openAiReasons = (model: string) =>
  /^(gpt-([5-9]|\d\d)|o\d)/i.test(model) && !/-chat/i.test(model);

/** Gemini on Vertex: it thinks within `max_tokens`, and its ids carry the publisher. */
const GEMINI: Dialect = {
  reasons: (model) => /(^|\/)gemini-/i.test(model),
  reasoningCap: "max_tokens",
  modelId: (model) => (model.includes("/") ? model : `google/${model}`),
};

/** OpenAI's models on Bedrock, the open-weight ones included: they think within their cap. */
const BEDROCK: Dialect = { reasons: (model) => /^openai\./i.test(model) };

/** A cloud answers Claude models in Claude's own format, and every other model as chat completions. */
function cloud(
  claude: ModelProviderAdapter,
  other: ModelProviderAdapter,
  baseUrl: (context: ModelContext) => string,
): ModelProviderAdapter {
  const at = (context: ModelContext): ModelContext => ({
    ...context,
    vendor: { ...context.vendor, baseUrl: baseUrl(context) },
  });
  return {
    text: (context) =>
      isClaudeModel(context.model) ? claude.text(context) : other.text(at(context)),
    chat: (context) =>
      isClaudeModel(context.model)
        ? (claude.chat?.(context) ?? null)
        : (other.chat?.(at(context)) ?? null),
  };
}

export function vendorAdapters(
  options: ProviderOptions = {},
): Record<Exclude<VendorName, "fake">, ModelProviderAdapter> {
  const { googleAuth, awsKeys, ...http } = options;
  const server = chatCompletions(http);
  const host: ClaudeHostOptions = { fetch: http.fetch, googleAuth, awsKeys };
  return {
    claude: anthropicProvider,
    openai: responses({ ...http, reasons: openAiReasons }),
    gcp: cloud(
      claudeOn(host),
      chatCompletions({ ...http, dialect: GEMINI, authorize: () => googleToken(googleAuth) }),
      ({ vendor }) =>
        `https://${vertexHost(vendor.location ?? "")}/v1/projects/${vendor.project}/locations/${vendor.location}/endpoints/openapi`,
    ),
    bedrock: cloud(
      claudeOn(host),
      chatCompletions({
        ...http,
        dialect: BEDROCK,
        authorize: ({ vendor }) =>
          awsSigned({ region: vendor.region ?? "", apiKey: vendor.apiKey, keys: awsKeys }),
      }),
      ({ vendor }) => `https://bedrock-runtime.${vendor.region}.amazonaws.com/openai/v1`,
    ),
    ollama: server,
    "llama.cpp": server,
    litellm: server,
    custom: server,
  };
}
