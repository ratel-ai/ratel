import type Anthropic from "@anthropic-ai/sdk";
import type { ModelStop, TextModel, TextReply, TextRequest } from "@/lib/contracts/models";
import type { ModelCallPayer } from "@/lib/contracts/telemetry";
import { anthropicUsage, trackModelCall } from "@/lib/platform/model-call";
import { anthropicContent } from "@/lib/platform/model-call-content";
import {
  type AnthropicClient,
  type AnthropicClientOptions,
  anthropicClient,
} from "@/lib/readings/anthropic/client";
import { wellFormedJson } from "@/lib/readings/text/well-formed";
import type { Env } from "../config";
import type { FeatureId } from "../features";
import type { ModelProviderAdapter } from "../index";
import { type ClaudeHostOptions, claudeHostClient, claudeHostName } from "./claude-hosts";

/**
 * Claude, on whichever backend `lib/readings/anthropic/client.ts` selects (the Anthropic API, or
 * Amazon Bedrock through EU profiles). The client is that file's, untouched, so where a call
 * goes and how it is signed is decided in one place as before (ADR-0033 §3).
 *
 * The request is the one the call sites built themselves before the kit: `system`, one user
 * message, and `output_config` carrying the schema and the effort when the feature gives them.
 * Effort is sent as given, on any model, as the sites sent it. The golden tests beside each
 * site hold this adapter to those requests.
 *
 * Usage keeps the Claude path's accounting (ADR-0033 §7): `inputTokens` is the prompt without
 * the cache, with the cache read beside it, which is what the eval gate's meter has always
 * priced. The spend line counts the cache inside input, through `anthropicUsage`, as before.
 */

export interface AnthropicTextContext {
  model: string;
  feature: FeatureId;
  payer: ModelCallPayer;
  env?: Env;
  /** The client to call with; `lib/readings/anthropic/client.ts` decides by default. */
  clientFor?: (options: AnthropicClientOptions) => AnthropicClient | null;
  /** Where that client calls, for the spend line; the deployment's Claude backend by default. */
  backend?: string;
}

function stopOf(reason: string | null): ModelStop {
  if (reason === "max_tokens") return "cut_off";
  return reason === "refusal" ? "refused" : "end";
}

/** Only what the caller set, so the client keeps its own defaults (and Bedrock its minimum retries). */
function clientOptions(request: TextRequest): AnthropicClientOptions {
  return {
    ...(request.timeoutMs !== undefined ? { timeout: request.timeoutMs } : {}),
    ...(request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {}),
  };
}

/** A Claude text model for one feature, or null when this environment has no Claude backend. */
export function anthropicTextModel(context: AnthropicTextContext): TextModel | null {
  const env = context.env ?? process.env;
  const clientFor = context.clientFor ?? ((options) => anthropicClient(options, env));
  if (!clientFor({})) return null;
  const { model } = context;
  // One client per time limit and retry count, kept for the model's life: a client looks its
  // cloud login up again each time it is built.
  const clients = new Map<string, AnthropicClient | null>();
  const clientOf = (request: TextRequest) => {
    const options = clientOptions(request);
    const key = JSON.stringify(options);
    const client = clients.get(key) ?? clientFor(options);
    clients.set(key, client);
    return client;
  };
  return {
    provider: "anthropic",
    model,
    async complete(request): Promise<TextReply> {
      const client = clientOf(request);
      if (!client) throw new Error("the Claude backend went away between two calls");
      const outputConfig = {
        ...(request.schema
          ? { format: { type: "json_schema" as const, schema: request.schema } }
          : {}),
        ...(request.effort ? { effort: request.effort } : {}),
      };
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: [{ role: "user", content: request.user }],
        ...(request.schema || request.effort ? { output_config: outputConfig } : {}),
      };
      const message = await trackModelCall<Anthropic.Message>(
        {
          provider: "anthropic",
          model,
          feature: context.feature,
          payer: context.payer,
          ...(context.backend ? { backend: context.backend } : {}),
          content: anthropicContent(params),
        },
        () =>
          request.longOutput
            ? client.messages.stream(wellFormedJson(params)).finalMessage()
            : client.messages.create(wellFormedJson(params)),
        anthropicUsage,
      );
      return {
        text: message.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join(""),
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          ...(message.usage.cache_read_input_tokens != null
            ? { cachedTokens: message.usage.cache_read_input_tokens }
            : {}),
        },
        model: message.model,
        stop: stopOf(message.stop_reason),
      };
    },
  };
}

/**
 * The adapter. No `chat`: the eval gate's Claude agent stays in `views/eval-gate/models.ts`
 * until it moves (ADR-0033 §11).
 */
export const anthropicProvider: ModelProviderAdapter = {
  text: (context) =>
    anthropicTextModel({
      model: context.model,
      feature: context.feature,
      payer: context.payer,
      env: context.env,
    }),
};

/** Claude on the cloud the deployment names as its vendor (`claude-hosts.ts`). */
export function claudeOn(host: ClaudeHostOptions = {}): ModelProviderAdapter {
  return {
    text: (context) =>
      anthropicTextModel({
        model: context.model,
        feature: context.feature,
        payer: context.payer,
        env: context.env,
        clientFor: (options) => claudeHostClient(context.vendor, options, host),
        backend: claudeHostName(context.vendor),
      }),
  };
}
