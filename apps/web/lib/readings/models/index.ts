import type { ChatModel, TextModel } from "@/lib/contracts/models";
import type { ModelCallPayer } from "@/lib/contracts/telemetry";
import { deploymentEnvironment } from "@/lib/platform/environment";
import { type AnthropicClient, anthropicClient } from "@/lib/readings/anthropic/client";
import {
  type Env,
  maxOutputTokens,
  modelIdFor,
  type ResolvedVendor,
  resolveModelVendor,
} from "./config";
import { fakeChatModel, fakeTextModel } from "./fake";
import { type ChatFeatureId, type FeatureId, featureRow, type TextFeatureId } from "./features";
import { vendorAdapters } from "./providers";
import { claudeHostClient, claudeHostName } from "./providers/claude-hosts";
import { isClaudeModel, VENDORS, type VendorName } from "./vendors";

/**
 * The model kit (ADR-0033): where a feature gets a model. It names what it is
 * (`models.text("workflow_label")`), never a provider or a model id, and gets the deployment's
 * model for it, or null when the deployment has none. Null is not an error: the feature reports
 * itself as not available, as it does today without a key.
 *
 * A vendor is a row in `vendors.ts` and an adapter in `providers/`. Each adapter records its own
 * spend line, because what a call sent and what it used is the vendor's shape.
 */

export type { ChatFeatureId, FeatureId, TextFeatureId } from "./features";

/** What an adapter is told when it builds a model for a feature. */
export interface ModelContext {
  /** The model id to send. */
  model: string;
  /** The spend line's feature. */
  feature: FeatureId;
  payer: ModelCallPayer;
  vendor: ResolvedVendor;
  env: Env;
}

/** One vendor: how to build its models. A vendor without `chat` cannot run a tool-using feature. */
export interface ModelProviderAdapter {
  text(context: ModelContext): TextModel | null;
  chat?(context: ModelContext): ChatModel | null;
}

export interface ModelOptions {
  env?: Env;
  environment?: string;
  /** Who pays for the call. Ratel, unless a customer's own traffic is being served. */
  payer?: ModelCallPayer;
  /** A model to run on in place of the feature's own (a replay of the model a run recorded). */
  model?: string;
}

const fakeProvider: ModelProviderAdapter = {
  text: (context) => fakeTextModel({ model: context.model }),
  chat: (context) => fakeChatModel({ model: context.model }),
};

let providers: Record<VendorName, ModelProviderAdapter> = {
  ...vendorAdapters(),
  fake: fakeProvider,
};

/** Register or replace adapters; returns a function that puts the previous set back. */
export function withProviders(next: Partial<Record<VendorName, ModelProviderAdapter>>): () => void {
  const previous = providers;
  providers = { ...providers, ...next };
  return () => {
    providers = previous;
  };
}

function contextFor(feature: FeatureId, options: ModelOptions): ModelContext | null {
  const env = options.env ?? process.env;
  const vendor = resolveModelVendor(env, options.environment ?? deploymentEnvironment());
  if (!vendor) return null;
  const model = options.model ?? modelIdFor(featureRow(feature), vendor, env);
  if (!model) return null;
  return { model, feature, payer: options.payer ?? "ratel", vendor, env };
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
    const model = providers[context.vendor.name]?.text(context) ?? null;
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
    const model = providers[context.vendor.name]?.chat?.(context) ?? null;
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

/** Claude as the deployment has it for a feature: what the eval gate's Claude code calls with. */
export interface ClaudeForFeature {
  client: AnthropicClient;
  model: string;
  /** Where the client calls, when that is not the deployment's `ANTHROPIC_BACKEND`. */
  backend?: string;
}

/**
 * The Claude client and model a feature runs on, or null when the deployment's vendor answers it
 * with another model (then `models` has it) or has none. One way in, so a deployment that names
 * another vendor cannot reach Claude through a key it also happens to have.
 */
export function claudeFor(feature: FeatureId, options: ModelOptions = {}): ClaudeForFeature | null {
  const context = contextFor(feature, options);
  if (!context || !isClaudeModel(context.model)) return null;
  const { vendor, model, env } = context;
  if (vendor.name === "claude") {
    const client = anthropicClient({}, env);
    return client && { client, model };
  }
  const client = claudeHostClient(vendor);
  return client && { client, model, backend: claudeHostName(vendor) };
}

/** Whether the deployment's vendor can replay this recorded model as it was. */
export function replaysModel(recorded: string, options: Omit<ModelOptions, "model"> = {}): boolean {
  const vendor = resolveModelVendor(
    options.env ?? process.env,
    options.environment ?? deploymentEnvironment(),
  );
  return vendor !== null && (VENDORS[vendor.name].replays?.test(recorded) ?? false);
}

/** Who a feature's calls are billed to, as its spend lines name it; Claude's when there is no vendor. */
export function providerFor(feature: FeatureId, options: ModelOptions = {}): string {
  const context = contextFor(feature, options);
  if (!context || isClaudeModel(context.model)) return VENDORS.claude.provider;
  return VENDORS[context.vendor.name].provider;
}

/** Whether this deployment has a text vendor at all. */
export function modelsConfigured(options: Pick<ModelOptions, "env" | "environment"> = {}): boolean {
  return (
    resolveModelVendor(
      options.env ?? process.env,
      options.environment ?? deploymentEnvironment(),
    ) !== null
  );
}
