import type { ChatModel, TextModel } from "@/lib/contracts/models";
import type { ModelCallPayer } from "@/lib/contracts/telemetry";
import { deploymentEnvironment } from "@/lib/platform/environment";
import {
  type Env,
  type ModelProviderName,
  maxOutputTokens,
  modelIdFor,
  type ResolvedModelProvider,
  resolveModelProvider,
} from "./config";
import { fakeChatModel, fakeTextModel } from "./fake";
import { type ChatFeatureId, type FeatureId, featureRow, type TextFeatureId } from "./features";
import { openAiCompatibleProvider } from "./providers/openai-compatible";

/**
 * The model kit (ADR-0033): where a feature gets a model. It names what it is
 * (`models.text("workflow_label")`), never a provider or a model id, and gets the deployment's
 * model for it, or null when the deployment has none. Null is not an error: the feature reports
 * itself as not available, as it does today without a key.
 *
 * A provider is one adapter in `providers/`, registered below. Each adapter records its own
 * spend line, because what a call sent and what it used is the provider's shape.
 */

export type { ChatFeatureId, FeatureId, TextFeatureId } from "./features";

/** What an adapter is told when it builds a model for a feature. */
export interface ModelContext {
  /** The model id to send. */
  model: string;
  /** The spend line's feature. */
  feature: FeatureId;
  payer: ModelCallPayer;
  provider: ResolvedModelProvider;
  env: Env;
}

/** One provider: how to build its models. A provider without `chat` cannot run a tool-using feature. */
export interface ModelProviderAdapter {
  text(context: ModelContext): TextModel | null;
  chat?(context: ModelContext): ChatModel | null;
}

export interface ModelOptions {
  env?: Env;
  environment?: string;
  /** Who pays for the call. Ratel, unless a customer's own traffic is being served. */
  payer?: ModelCallPayer;
}

const fakeProvider: ModelProviderAdapter = {
  text: (context) => fakeTextModel({ model: context.model }),
  chat: (context) => fakeChatModel({ model: context.model }),
};

let providers: Partial<Record<ModelProviderName, ModelProviderAdapter>> = {
  "openai-compatible": openAiCompatibleProvider(),
  fake: fakeProvider,
};

/** Register or replace adapters; returns a function that puts the previous set back. */
export function withProviders(
  next: Partial<Record<ModelProviderName, ModelProviderAdapter>>,
): () => void {
  const previous = providers;
  providers = { ...providers, ...next };
  return () => {
    providers = previous;
  };
}

function contextFor(feature: FeatureId, options: ModelOptions): ModelContext | null {
  const env = options.env ?? process.env;
  const provider = resolveModelProvider(env, options.environment ?? deploymentEnvironment());
  if (!provider) return null;
  const model = modelIdFor(featureRow(feature), provider, env);
  if (!model) return null;
  return { model, feature, payer: options.payer ?? "ratel", provider, env };
}

function expectKind(feature: FeatureId, kind: "text" | "chat"): void {
  const actual = featureRow(feature).kind;
  if (actual !== kind) throw new Error(`${feature} is a ${actual} feature, asked for as ${kind}`);
}

/** Never ask a model for more than the deployment allows (`MODEL_MAX_OUTPUT_TOKENS`). */
function capped<T extends { maxTokens: number }>(request: T, cap: number | undefined): T {
  return cap !== undefined && request.maxTokens > cap ? { ...request, maxTokens: cap } : request;
}

export const models = {
  /** The text model a feature runs on, or null when this deployment has none for it. */
  text(feature: TextFeatureId, options: ModelOptions = {}): TextModel | null {
    expectKind(feature, "text");
    const context = contextFor(feature, options);
    if (!context) return null;
    const model = providers[context.provider.name]?.text(context) ?? null;
    if (!model) return null;
    const cap = maxOutputTokens(context.env);
    if (cap === undefined) return model;
    return {
      provider: model.provider,
      model: model.model,
      complete: (request) => model.complete(capped(request, cap)),
    };
  },

  /** The tool-calling model a feature runs on, or null when this deployment has none for it. */
  chat(feature: ChatFeatureId, options: ModelOptions = {}): ChatModel | null {
    expectKind(feature, "chat");
    const context = contextFor(feature, options);
    if (!context) return null;
    const model = providers[context.provider.name]?.chat?.(context) ?? null;
    if (!model) return null;
    const cap = maxOutputTokens(context.env);
    if (cap === undefined) return model;
    return {
      provider: model.provider,
      model: model.model,
      next: (request) => model.next(capped(request, cap)),
    };
  },
};

/** Whether this deployment has a text provider at all. */
export function modelsConfigured(options: Pick<ModelOptions, "env" | "environment"> = {}): boolean {
  return (
    resolveModelProvider(
      options.env ?? process.env,
      options.environment ?? deploymentEnvironment(),
    ) !== null
  );
}
