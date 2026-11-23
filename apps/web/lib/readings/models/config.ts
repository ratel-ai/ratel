import type { ModelTier } from "@/lib/contracts/models";
import { configured } from "@/lib/platform/env-configured";
import { deploymentEnvironment } from "@/lib/platform/environment";
import { anthropicConfigured } from "@/lib/readings/anthropic/client";
import type { FeatureRow } from "./features";
import { VENDORS, type VendorName, vendorNamed } from "./vendors";

/**
 * Which vendor serves this deployment's text and chat models, read from the environment
 * (ADR-0033 §3, §4): the one place the kit reads a variable to choose a vendor. Unset is Claude
 * exactly as `ANTHROPIC_BACKEND` and `ANTHROPIC_API_KEY` decide today. A named vendor is used or
 * nothing is: it never falls back to another one, and a name the vendor table does not have gives
 * nothing, so a typo cannot move customer data. A vendor's key is sent to that vendor only.
 */

export type Env = Record<string, string | undefined>;

export interface ResolvedVendor {
  name: VendorName;
  /** The server's base URL, without a trailing slash. */
  baseUrl?: string;
  /** Absent for a server that asks for none. */
  apiKey?: string;
  /** `gcp`. */
  project?: string;
  location?: string;
  /** `bedrock`. */
  region?: string;
  /** `bedrock`: the geography Claude's inference profiles stay in. */
  profile?: string;
}

/** Where the fake vendor may run. An allowlist: an unknown or empty environment is not local. */
const LOCAL_ENVIRONMENTS: ReadonlySet<string> = new Set(["development", "local", "test"]);

/** The one model the fake vendor names. */
export const FAKE_MODEL = "fake-model-local";

const TIER_VARIABLE: Readonly<Record<ModelTier, string>> = {
  deep: "MODEL_DEEP",
  standard: "MODEL_STANDARD",
  fast: "MODEL_FAST",
};

/** Both land in a URL's host or path, so each must be the plain word it is. */
const CLOUD_WORD = /^[a-z0-9][a-z0-9-]*$/;

const BEDROCK_PROFILES: ReadonlySet<string> = new Set(["global", "us", "eu", "jp", "au"]);

/** The geography a region's Claude calls stay in; none where Bedrock has no profile of its own. */
function bedrockProfileOf(region: string): string | undefined {
  if (region.startsWith("eu-")) return "eu";
  if (region.startsWith("us-") && !region.startsWith("us-gov-")) return "us";
  if (region === "ap-northeast-1" || region === "ap-northeast-3") return "jp";
  return region === "ap-southeast-2" || region === "ap-southeast-4" ? "au" : undefined;
}

/** A server's address without a trailing slash, with `path` when it names none; null when it is no URL. */
function serverUrl(value: string | undefined, path: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const trimmed = value.replace(/\/+$/, "");
  return path && url.pathname === "/" ? `${trimmed}${path}` : trimmed;
}

/** The vendor this environment selects, or null when it selects none that can run. */
export function resolveModelVendor(
  env: Env = process.env,
  environment: string = deploymentEnvironment(),
): ResolvedVendor | null {
  const vendor = vendorNamed(configured(env.MODEL_PROVIDER) ?? "claude");
  if (!vendor) return null;
  const { name } = vendor;
  if (name === "claude") return anthropicConfigured(env) ? { name } : null;
  if (name === "fake") return LOCAL_ENVIRONMENTS.has(environment.toLowerCase()) ? { name } : null;

  if (name === "gcp") {
    const project = configured(env.GOOGLE_CLOUD_PROJECT);
    const location = configured(env.GOOGLE_CLOUD_LOCATION);
    if (!project || !location) return null;
    return CLOUD_WORD.test(project) && CLOUD_WORD.test(location)
      ? { name, project, location }
      : null;
  }
  if (name === "bedrock") {
    const region = configured(env.AWS_REGION);
    if (!region || !CLOUD_WORD.test(region)) return null;
    const profile = configured(env.BEDROCK_PROFILE) ?? bedrockProfileOf(region);
    if (!profile || !BEDROCK_PROFILES.has(profile)) return null;
    const apiKey = configured(env.AWS_BEARER_TOKEN_BEDROCK);
    return { name, region, profile, ...(apiKey ? { apiKey } : {}) };
  }

  const ownKey = configured(env.MODEL_API_KEY);
  const ownUrl = configured(env.MODEL_BASE_URL);
  if (vendor.baseUrl) {
    // A hosted vendor. At another address (a gateway), its own key is not sent.
    const baseUrl = ownUrl ? serverUrl(ownUrl, undefined) : vendor.baseUrl;
    const apiKey = ownKey ?? (ownUrl ? undefined : configured(env[vendor.keyVariable ?? ""]));
    return baseUrl && apiKey ? { name, baseUrl, apiKey } : null;
  }
  const baseUrl = serverUrl(ownUrl, vendor.path);
  if (!baseUrl) return null;
  return ownKey ? { name, baseUrl, apiKey: ownKey } : { name, baseUrl };
}

/** The variable that names one feature's model on any vendor. */
export function featureVariable(id: string): string {
  return `MODEL_FEATURE_${id.toUpperCase()}`;
}

/**
 * The model a feature runs on with this vendor, or null when the deployment names none: the
 * feature's `MODEL_FEATURE_…` variable; on a vendor that serves Claude, the variables the feature
 * has always read; the tier's variable; the vendor's model for the tier (on one that serves
 * Claude, the feature's own Claude model); and, on a vendor with no models of its own,
 * `MODEL_STANDARD`.
 */
export function modelIdFor(
  feature: FeatureRow,
  resolved: Pick<ResolvedVendor, "name">,
  env: Env = process.env,
): string | null {
  const vendor = VENDORS[resolved.name];
  if (vendor.name === "fake") return FAKE_MODEL;
  const named = [
    featureVariable(feature.id),
    ...(vendor.servesClaude ? (feature.variables ?? []) : []),
    ...(feature.tier ? [TIER_VARIABLE[feature.tier]] : []),
  ];
  for (const variable of named) {
    const model = configured(env[variable]);
    if (model) return model;
  }
  if (vendor.servesClaude) return feature.claudeDefault ?? null;
  if (vendor.models) return feature.tier ? vendor.models[feature.tier] : null;
  return configured(env.MODEL_STANDARD) ?? null;
}

/** `MODEL_MAX_OUTPUT_TOKENS`: the most any call may ask a model to generate, when set. */
export function maxOutputTokens(env: Env = process.env): number | undefined {
  const raw = configured(env.MODEL_MAX_OUTPUT_TOKENS);
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return value > 0 ? value : undefined;
}
