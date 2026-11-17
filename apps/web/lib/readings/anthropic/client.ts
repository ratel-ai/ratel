import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { configured } from "@/lib/readings/decisions/engine";
import { wellFormedJson } from "@/lib/readings/text/well-formed";

/**
 * The one place Cloud gets a Claude client, so one setting decides where
 * customer data goes.
 *
 * `ANTHROPIC_BACKEND=bedrock` serves every call from Amazon Bedrock through an
 * EU inference profile, signed with the task role. That choice is final: it
 * never reads `ANTHROPIC_API_KEY`, and a model with no EU profile fails instead
 * of going to a global or US profile. Without the setting, `ANTHROPIC_API_KEY`
 * selects the Anthropic API (local development and self-hosting). Any other
 * value gives no client, so a typo cannot send data to the wrong place. The host
 * is fixed, so `ANTHROPIC_BEDROCK_BASE_URL` cannot move it. `AWS_BEARER_TOKEN_BEDROCK`
 * gives no client, because it would replace the task role and its IAM policy.
 *
 * Call sites keep Anthropic's model ids: spend and pricing stay keyed on them,
 * and only the request carries the Bedrock id. The SDK's own OpenTelemetry spans
 * stay off: `trackModelCall` already records each call, and these spans would
 * go to the self-telemetry exporter with no decision about their contents.
 */

/** What the call sites use of a client. Both backends provide it. */
export type AnthropicClient = {
  messages: Pick<Anthropic["messages"], "create" | "stream">;
};

export type AnthropicClientOptions = {
  timeout?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
};

type Env = Record<string, string | undefined>;

/** The Region that signs the call. From here the `eu.` profiles stay in EU member states (London and Zurich excluded). */
const BEDROCK_REGION = "eu-central-1";

/**
 * The EU inference profile of each model that has one, from AWS's model cards.
 * Claude Fable has none: it is global only.
 */
const EU_PROFILES: Readonly<Record<string, string>> = {
  "claude-opus-5-5": "eu.anthropic.claude-opus-5-5",
  "claude-opus-5": "eu.anthropic.claude-opus-5",
  "claude-opus-4-8": "eu.anthropic.claude-opus-4-8",
  "claude-opus-4-7": "eu.anthropic.claude-opus-4-7",
  "claude-opus-4-6": "eu.anthropic.claude-opus-4-6-v1",
  "claude-opus-4-5": "eu.anthropic.claude-opus-4-5-20251101-v1:0",
  "claude-sonnet-5-5": "eu.anthropic.claude-sonnet-5-5",
  "claude-sonnet-5": "eu.anthropic.claude-sonnet-5",
  "claude-sonnet-4-6": "eu.anthropic.claude-sonnet-4-6",
  "claude-sonnet-4-5": "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "claude-haiku-5-5": "eu.anthropic.claude-haiku-5-5",
  "claude-haiku-4-5": "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
};

/** A client for this deployment's backend, or null when it has none. */
export function anthropicClient(
  options: AnthropicClientOptions = {},
  env: Env = process.env,
): AnthropicClient | null {
  const backend = configured(env.ANTHROPIC_BACKEND);
  if (backend === "bedrock")
    return configured(env.AWS_BEARER_TOKEN_BEDROCK) ? null : euBedrockClient(options);
  if (backend !== undefined) return null;
  const apiKey = configured(env.ANTHROPIC_API_KEY);
  return apiKey ? new Anthropic({ ...options, apiKey, openTelemetry: false }) : null;
}

/** Whether this deployment can call Claude at all. */
export function anthropicConfigured(env: Env = process.env): boolean {
  const backend = configured(env.ANTHROPIC_BACKEND);
  if (backend !== undefined)
    return backend === "bedrock" && !configured(env.AWS_BEARER_TOKEN_BEDROCK);
  return configured(env.ANTHROPIC_API_KEY) !== undefined;
}

/** Bedrock with each model id swapped for its EU profile, signed by the AWS credential chain. */
function euBedrockClient(options: AnthropicClientOptions): AnthropicClient {
  const client = new AnthropicBedrock({
    ...options,
    openTelemetry: false,
    awsRegion: BEDROCK_REGION,
    baseURL: `https://bedrock-runtime.${BEDROCK_REGION}.amazonaws.com`,
  });
  const create = async (
    params: Anthropic.MessageCreateParams,
    requestOptions?: Anthropic.RequestOptions,
  ) =>
    client.messages.create(
      wellFormedJson({ ...params, model: euProfile(params.model) }),
      requestOptions,
    );
  const stream = (
    params: Anthropic.MessageStreamParams,
    requestOptions?: Anthropic.RequestOptions,
  ) =>
    client.messages.stream(
      wellFormedJson({ ...params, model: euProfile(params.model) }),
      requestOptions,
    );
  return { messages: { create, stream } as unknown as AnthropicClient["messages"] };
}

/**
 * The EU profile of a model id, a dated snapshot included. A model without one
 * is "not found": the answer call sites already handle for a retired model.
 */
function euProfile(model: string): string {
  const profile = EU_PROFILES[model.replace(/-\d{8}$/, "")];
  if (profile) return profile;
  throw new Anthropic.NotFoundError(
    404,
    undefined,
    `Model ${model} has no EU inference profile on Bedrock`,
    new Headers(),
  );
}
