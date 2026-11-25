import { type Config, getConfig } from "@/config";
import { deploymentEnvironment } from "@/lib/platform/environment";
import { anthropicConfigured } from "@/lib/readings/anthropic/client";
import type { ClaudeModelSetting, FeatureRow } from "./features";
import { VENDORS, type VendorName, vendorNamed } from "./vendors";

/**
 * Which vendor serves this deployment's text and chat models, read from the settings
 * (ADR-0009 §3, §4): the one place the kit reads one to choose a vendor. Unset is Claude exactly
 * as `anthropic.backend` and `anthropic.apiKey` decide today. A named vendor is used or
 * nothing is: it never falls back to another one, and a name the vendor table does not have gives
 * nothing, so a typo cannot move customer data. A vendor's key is sent to that vendor only.
 */

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
  config: Config = getConfig(),
  environment: string = deploymentEnvironment(),
): ResolvedVendor | null {
  const { modelVendor, vendors } = config;
  const vendor = vendorNamed(modelVendor.name ?? "claude");
  if (!vendor) return null;
  const { name } = vendor;
  if (name === "claude") return anthropicConfigured(config) ? { name } : null;
  if (name === "fake") return LOCAL_ENVIRONMENTS.has(environment.toLowerCase()) ? { name } : null;

  if (name === "gcp") {
    const project = vendors.googleCloudProject;
    const location = vendors.googleCloudLocation;
    if (!project || !location) return null;
    return CLOUD_WORD.test(project) && CLOUD_WORD.test(location)
      ? { name, project, location }
      : null;
  }
  if (name === "bedrock") {
    const region = vendors.awsRegion;
    if (!region || !CLOUD_WORD.test(region)) return null;
    const profile = vendors.bedrockProfile ?? bedrockProfileOf(region);
    if (!profile || !BEDROCK_PROFILES.has(profile)) return null;
    const apiKey = config.anthropic.bedrockBearerToken;
    return { name, region, profile, ...(apiKey ? { apiKey } : {}) };
  }

  const ownKey = modelVendor.apiKey;
  const ownUrl = modelVendor.baseUrl;
  if (vendor.baseUrl) {
    // A hosted vendor. At another address (a gateway), its own key is not sent.
    const baseUrl = ownUrl ? serverUrl(ownUrl, undefined) : vendor.baseUrl;
    const apiKey = ownKey ?? (ownUrl ? undefined : vendor.key?.(config));
    return baseUrl && apiKey ? { name, baseUrl, apiKey } : null;
  }
  const baseUrl = serverUrl(ownUrl, vendor.path);
  if (!baseUrl) return null;
  return ownKey ? { name, baseUrl, apiKey: ownKey } : { name, baseUrl };
}

function claudeSetting(config: Config, setting: ClaudeModelSetting): string | undefined {
  const [group, key] = setting.split(".") as [string, string];
  return (config as unknown as Record<string, Record<string, string | undefined>>)[group]?.[key];
}

/**
 * The model a feature runs on with this vendor, or null when the deployment names none: the
 * feature's own setting; on a vendor that serves Claude, the settings the feature has always read;
 * the model set for every feature (MODEL); the vendor's model for the feature's tier (on one that
 * serves Claude, the feature's own Claude model). A server has no models of its own.
 */
export function modelIdFor(
  feature: FeatureRow,
  resolved: Pick<ResolvedVendor, "name">,
  config: Config = getConfig(),
): string | null {
  const vendor = VENDORS[resolved.name];
  if (vendor.name === "fake") return FAKE_MODEL;
  const { modelVendor } = config;
  const named = [
    modelVendor.features[feature.id],
    ...(vendor.servesClaude
      ? (feature.settings ?? []).map((setting) => claudeSetting(config, setting))
      : []),
    modelVendor.model,
  ].find(Boolean);
  if (named) return named;
  if (vendor.servesClaude) return feature.claudeDefault ?? null;
  if (vendor.models) return feature.tier ? vendor.models[feature.tier] : null;
  return null;
}
