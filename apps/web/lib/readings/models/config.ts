import type { ModelTier } from "@/lib/contracts/models";
import { configured } from "@/lib/platform/env-configured";
import { deploymentEnvironment } from "@/lib/platform/environment";
import { anthropicConfigured } from "@/lib/readings/anthropic/client";
import type { FeatureRow } from "./features";

/**
 * Which provider serves this deployment's text and chat models, read from the environment
 * (ADR-0033 §3, §4). Unset is Claude exactly as `ANTHROPIC_BACKEND` and `ANTHROPIC_API_KEY`
 * decide today. A named provider is used or nothing is: it never falls back to another one, and
 * a name this file does not know gives no provider, so a typo cannot move customer data.
 */

export type Env = Record<string, string | undefined>;

export type ModelProviderName = "anthropic" | "openai-compatible" | "fake";

export interface ResolvedModelProvider {
  name: ModelProviderName;
  /** `openai-compatible`: the server's base URL, without a trailing slash. */
  baseUrl?: string;
  /** `openai-compatible`: absent for a local server that asks for none. */
  apiKey?: string;
}

/** Where the fake provider may run. An allowlist: an unknown or empty environment is not local. */
const LOCAL_ENVIRONMENTS: ReadonlySet<string> = new Set(["development", "local", "test"]);

/** The one model the fake provider names. */
export const FAKE_MODEL = "fake-model-local";

const TIER_VARIABLE: Readonly<Record<ModelTier, string>> = {
  deep: "MODEL_DEEP",
  standard: "MODEL_STANDARD",
  fast: "MODEL_FAST",
};

/** The provider this environment selects, or null when it selects none that can run. */
export function resolveModelProvider(
  env: Env = process.env,
  environment: string = deploymentEnvironment(),
): ResolvedModelProvider | null {
  const name = configured(env.MODEL_PROVIDER)?.toLowerCase();
  if (name === undefined || name === "anthropic") {
    return anthropicConfigured(env) ? { name: "anthropic" } : null;
  }
  if (name === "openai-compatible") {
    // A server without a key is a real setup, so the URL alone is what says "use this".
    const baseUrl = configured(env.MODEL_BASE_URL)?.replace(/\/+$/, "");
    if (!baseUrl) return null;
    const apiKey = configured(env.MODEL_API_KEY);
    return apiKey ? { name, baseUrl, apiKey } : { name, baseUrl };
  }
  if (name === "fake") {
    return LOCAL_ENVIRONMENTS.has(environment.toLowerCase()) ? { name } : null;
  }
  return null;
}

/**
 * The model a feature runs on with this provider, or null when the deployment names none.
 * On Claude: the feature's own variables in order, then its default. Elsewhere: the tier's
 * variable, then `MODEL_STANDARD`. The two never mix, so a Claude id is not sent to another
 * provider and the tier variables never move a Claude deployment.
 */
export function modelIdFor(
  feature: FeatureRow,
  provider: ResolvedModelProvider,
  env: Env = process.env,
): string | null {
  if (provider.name === "fake") return FAKE_MODEL;
  if (provider.name === "anthropic") {
    for (const variable of feature.variables ?? []) {
      const named = configured(env[variable]);
      if (named) return named;
    }
    return feature.claudeDefault ?? null;
  }
  const tier = feature.tier;
  return (
    (tier ? configured(env[TIER_VARIABLE[tier]]) : undefined) ??
    configured(env.MODEL_STANDARD) ??
    null
  );
}

/** `MODEL_MAX_OUTPUT_TOKENS`: the most any call may ask a model to generate, when set. */
export function maxOutputTokens(env: Env = process.env): number | undefined {
  const raw = configured(env.MODEL_MAX_OUTPUT_TOKENS);
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return value > 0 ? value : undefined;
}
