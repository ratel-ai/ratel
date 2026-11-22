import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { type Config, getConfig } from "@/config";
import { anthropicBackend } from "@/lib/platform/anthropic-backend";
import { asModelNotEnabled, modelsSeenNotEnabled } from "@/lib/platform/anthropic-errors";
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
 *
 * On Bedrock a call retries a 503 or a throttle at least `BEDROCK_MIN_RETRIES`
 * times, whatever the caller asked for: those errors are the shared EU
 * profiles' capacity, not the request. The API path keeps the caller's setting.
 *
 * On Bedrock a 403 for a model whose AWS Marketplace agreement is not accepted
 * comes back as `ModelNotEnabledError` (a `PermissionDeniedError`). A streamed
 * call keeps the SDK's own error.
 */

export { type AnthropicBackend, anthropicBackend } from "@/lib/platform/anthropic-backend";
export { ModelNotEnabledError } from "@/lib/platform/anthropic-errors";

/** What the call sites use of a client. Both backends provide it. */
export type AnthropicClient = {
  messages: Pick<Anthropic["messages"], "create" | "stream">;
};

export type AnthropicClientOptions = {
  timeout?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
};

/** The fewest retries a Bedrock call gets for a 429, a 5xx or a timeout (the SDK's default). */
export const BEDROCK_MIN_RETRIES = 2;

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
  config: Pick<Config, "anthropic"> = getConfig(),
): AnthropicClient | null {
  const { backend, apiKey } = config.anthropic;
  if (backend === "bedrock") return bedrockBearerToken() ? null : euBedrockClient(options);
  if (backend !== undefined) return null;
  return apiKey ? new Anthropic({ ...options, apiKey, openTelemetry: false }) : null;
}

/** Whether this deployment can call Claude at all. */
export function anthropicConfigured(config: Pick<Config, "anthropic"> = getConfig()): boolean {
  const { backend, apiKey } = config.anthropic;
  if (backend !== undefined) return backend === "bedrock" && !bedrockBearerToken();
  return apiKey !== undefined;
}

/**
 * RC-653: the Claude models a caller may choose for this deployment: every
 * model with an EU profile (on the API too, so a choice made locally also runs
 * in prod). Empty when the deployment has no client.
 */
export function servedClaudeModels(config: Pick<Config, "anthropic"> = getConfig()): string[] {
  return anthropicConfigured(config) ? [...CLAUDE_MODELS] : [];
}

/** Every Claude model id Cloud can call on either backend. */
export const CLAUDE_MODELS: readonly string[] = Object.keys(EU_PROFILES);

/**
 * RC-653, RC-589: the served models that Bedrock has not enabled for this AWS
 * account: those named in `BEDROCK_MODELS_NOT_ENABLED` (comma-separated), and
 * those this process saw refused with `model_not_enabled`. Empty on the API.
 */
export function modelsNotEnabled(config: Pick<Config, "anthropic"> = getConfig()): Set<string> {
  if (anthropicBackend(config) !== "bedrock") return new Set();
  const listed = (config.anthropic.bedrockModelsNotEnabled ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  return new Set([...listed, ...modelsSeenNotEnabled()]);
}

/** Bedrock with each model id swapped for its EU profile, signed by the AWS credential chain. */
function euBedrockClient(options: AnthropicClientOptions): AnthropicClient {
  const client = new AnthropicBedrock({
    ...options,
    maxRetries: Math.max(options.maxRetries ?? BEDROCK_MIN_RETRIES, BEDROCK_MIN_RETRIES),
    openTelemetry: false,
    awsRegion: BEDROCK_REGION,
    baseURL: `https://bedrock-runtime.${BEDROCK_REGION}.amazonaws.com`,
  });
  const create = async (
    params: Anthropic.MessageCreateParams,
    requestOptions?: Anthropic.RequestOptions,
  ) => {
    const profile = euProfile(params.model);
    try {
      return await client.messages.create(
        wellFormedJson({ ...params, model: profile }),
        requestOptions,
      );
    } catch (err) {
      throw asModelNotEnabled(err, params.model, profile);
    }
  };
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

/**
 * `AWS_BEARER_TOKEN_BEDROCK`, which the AWS SDK reads itself (an exception in `web/src/config.ts`):
 * a long-term key, refused here so the calls are signed by the credential chain. Read from the
 * environment, as the SDK reads it; the placeholder and a blank value count as unset.
 */
function bedrockBearerToken(): string | undefined {
  const token = process.env.AWS_BEARER_TOKEN_BEDROCK?.trim();
  return token && token !== "REPLACE_ME" ? token : undefined;
}
