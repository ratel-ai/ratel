import { type Config, getConfig } from "@/config";
import {
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  OPENAI_EMBEDDINGS_BASE_URL as OPENAI_EMBEDDINGS_URL,
} from "@/lib/adapters/oss/embedding-provider";
import { ModelNotEnabledError } from "@/lib/platform/anthropic-errors";
import { deploymentEnvironment } from "@/lib/platform/environment";
import { type DecisionEngineName, resolveDecisionEngine } from "@/lib/readings/decisions/engine";
import { OPENAI_DECISIONS_MODEL, OPENAI_DEFAULT_BASE_URL } from "@/lib/readings/decisions/openai";
import { DECISION_VENDORS, decisionVendorNamed } from "@/lib/readings/decisions/vendors";
import { modelIdFor, type ResolvedVendor, resolveModelVendor } from "./config";
import { FEATURES, featureRow, featureVariable, isFeature } from "./features";
import { VENDORS, type VendorName, vendorNamed } from "./vendors";

/**
 * What a self-hoster needs to read when the models do not work (ADR-0009 §13): which vendor each
 * kind of model runs on, or why none does, and one sentence per failed call that names the
 * setting to fix. Read by the startup log, the failure log and the console's Models settings.
 *
 * Every sentence is built from setting names, vendor names, model ids, places and a status code.
 * Never a key, and never the provider's own words: those can echo a prompt or a key back.
 */

export interface FeatureSetup {
  feature: string;
  /** What the feature does. */
  does: string;
  /** The model it runs on; null when this deployment names none for it. */
  model: string | null;
  /** Why it has none. */
  reason?: string;
}

export interface KindSetup {
  /** Whether this kind of model runs at all. */
  on: boolean;
  /** The vendor, as people call it. */
  vendor?: string;
  /** Where its calls go: a region, a project, an address. Never credentials. */
  where?: string;
  /** The one model of a kind that has one (decisions, embeddings). */
  model?: string;
  /** Why it is off. */
  reason?: string;
  /** Whether a setting asked for it: an "off" that nobody asked for is not a problem. */
  asked: boolean;
}

export interface TextSetup extends KindSetup {
  features: FeatureSetup[];
}

const TEXT_NAMES = Object.keys(VENDORS).filter((name) => name !== "fake");
const DECISION_NAMES = Object.keys(DECISION_VENDORS);

/** What people write for a vendor, beside its name. */
const TEXT_HINTS: Readonly<Record<string, string>> = {
  vertex: "gcp",
  google: "gcp",
  gemini: "gcp",
  aws: "bedrock",
  "openai-compatible": "custom",
};
const DECISION_HINTS: Readonly<Record<string, string>> = {
  sage: "levanto",
  jev: "typesafe",
  gemini: "google",
  system1: "custom",
  "system-one": "custom",
};

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const kept = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = kept;
    }
  }
  return row[b.length];
}

function notAVendor(
  variable: string,
  value: string,
  names: string[],
  hints: Record<string, string>,
) {
  const lower = value.trim().toLowerCase();
  const near = hints[lower] ?? names.find((name) => distance(lower, name) <= 2 && lower.length > 2);
  const suggestion = near ? ` Did you mean ${near}?` : "";
  return `${variable}=${value.trim()} is not a vendor.${suggestion} The names are: ${names.join(", ")}.`;
}

/** An address as it can be shown: without the user and password some URLs carry. */
function shown(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return url;
  }
}

function isUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

const CLOUD_WORD = /^[a-z0-9][a-z0-9-]*$/;

/* - Text and chat ----------------------------------------------------------- */

/** Why `resolveModelVendor` gave nothing. Mirrors its order; the tests hold the two together. */
function whyNoTextVendor(config: Config, environment: string): string {
  const { modelVendor, vendors, anthropic } = config;
  const named = modelVendor.name;
  const vendor = vendorNamed(named ?? "claude");
  if (!vendor) return notAVendor("MODEL_PROVIDER", named ?? "", TEXT_NAMES, TEXT_HINTS);
  switch (vendor.name) {
    case "claude": {
      if (anthropic.backend !== undefined && anthropic.backend !== "bedrock")
        return `ANTHROPIC_BACKEND=${anthropic.backend} is not a backend: the one there is is bedrock. Unset it for the Anthropic API.`;
      if (anthropic.backend === "bedrock")
        return "AWS_BEARER_TOKEN_BEDROCK is set, which ANTHROPIC_BACKEND=bedrock does not use: it signs with the AWS role. Remove it, or use MODEL_PROVIDER=bedrock, which takes it.";
      return named === undefined
        ? "No text model: set MODEL_PROVIDER to a vendor, or ANTHROPIC_API_KEY for Claude."
        : "claude needs ANTHROPIC_API_KEY.";
    }
    case "fake":
      return `MODEL_PROVIDER=fake works only in a local, development or test environment, not ${environment || "an unnamed one"}.`;
    case "gcp": {
      const project = vendors.googleCloudProject;
      const location = vendors.googleCloudLocation;
      if (!project) return "gcp needs GOOGLE_CLOUD_PROJECT, the id of the Google Cloud project.";
      if (!location) return "gcp needs GOOGLE_CLOUD_LOCATION: global, us, eu or a region.";
      if (!CLOUD_WORD.test(project))
        return `GOOGLE_CLOUD_PROJECT=${project} is not a project id: lower-case letters, digits and dashes.`;
      return `GOOGLE_CLOUD_LOCATION=${location} is not a location: global, us, eu or a region such as europe-west1.`;
    }
    case "bedrock": {
      const region = vendors.awsRegion;
      if (!region) return "bedrock needs AWS_REGION, such as eu-central-1.";
      if (!CLOUD_WORD.test(region)) return `AWS_REGION=${region} is not a region.`;
      const profile = vendors.bedrockProfile;
      if (profile !== undefined)
        return `BEDROCK_PROFILE=${profile} is not a geography: global, us, eu, jp or au.`;
      return `AWS_REGION=${region} has no Claude geography of its own: set BEDROCK_PROFILE to global, us, eu, jp or au.`;
    }
    default:
      break;
  }
  const ownUrl = modelVendor.baseUrl;
  if (ownUrl !== undefined && !isUrl(ownUrl))
    return `MODEL_BASE_URL=${ownUrl} is not an address: write it with http:// or https://.`;
  if (vendor.baseUrl) {
    if (ownUrl && !modelVendor.apiKey)
      return `MODEL_BASE_URL is set, so the ${vendor.label} key is not sent there: set MODEL_API_KEY for that address.`;
    return `${vendor.name} needs OPENAI_API_KEY.`;
  }
  return `${vendor.name} needs MODEL_BASE_URL, the server's address.`;
}

function claudeWhere(config: Config): string {
  return config.anthropic.backend === "bedrock"
    ? "Bedrock, EU profiles (ANTHROPIC_BACKEND=bedrock)"
    : "Anthropic API";
}

function textWhere(vendor: ResolvedVendor, config: Config): string | undefined {
  switch (vendor.name) {
    case "claude":
      return claudeWhere(config);
    case "gcp":
      return `${vendor.project}, ${vendor.location}`;
    case "bedrock":
      return `${vendor.region}, ${vendor.profile} profile`;
    case "fake":
      return undefined;
    default:
      return vendor.baseUrl ? shown(vendor.baseUrl) : undefined;
  }
}

function textVendorLabel(vendor: ResolvedVendor, config: Config): string {
  if (vendor.name === "claude" && config.anthropic.backend === "bedrock")
    return "Claude on Bedrock";
  return VENDORS[vendor.name].label;
}

/** The text vendor and each feature's model, or why there is none. */
export function explainTextSetup(
  config: Config = getConfig(),
  environment: string = deploymentEnvironment(),
): TextSetup {
  const asked =
    config.modelVendor.name !== undefined ||
    config.anthropic.backend !== undefined ||
    config.anthropic.apiKey !== undefined;
  const rows = FEATURES.filter((row) => row.kind !== "decision");
  const vendor = resolveModelVendor(config, environment);
  if (!vendor) {
    return {
      on: false,
      asked,
      reason: whyNoTextVendor(config, environment),
      features: rows.map((row) => ({ feature: row.id, does: row.does, model: null })),
    };
  }
  const features = rows.map((row): FeatureSetup => {
    const model = modelIdFor(row, vendor, config);
    return model
      ? { feature: row.id, does: row.does, model }
      : {
          feature: row.id,
          does: row.does,
          model: null,
          reason: `${VENDORS[vendor.name].label} has no model of its own: set MODEL, or ${featureVariable(row.id)} for this feature.`,
        };
  });
  const where = textWhere(vendor, config);
  return {
    on: true,
    asked,
    vendor: textVendorLabel(vendor, config),
    ...(where ? { where } : {}),
    features,
  };
}

/* - Decisions --------------------------------------------------------------- */

const DECISION_KEYS: Readonly<Record<DecisionEngineName, string>> = {
  openai: "OPENAI_API_KEY",
  typesafe: "TYPESAFE_API_KEY",
  levanto: "SAGE_API_KEY",
  google: "GEMINI_API_KEY",
  custom: "DECISION_API_KEY",
};

function decisionVendorName(config: Config): DecisionEngineName | null {
  const named = config.decisions.vendor;
  if (named === undefined) return "openai";
  return decisionVendorNamed(named)?.name ?? null;
}

/** Why `resolveDecisionEngine` gave nothing. Mirrors its order; the tests hold the two together. */
function whyNoDecisionVendor(config: Config): string {
  const { decisions } = config;
  const name = decisionVendorName(config);
  if (!name)
    return notAVendor("DECISION_PROVIDER", decisions.vendor ?? "", DECISION_NAMES, DECISION_HINTS);
  const ownUrl = decisions.baseUrl;
  if (name === "custom") {
    if (!ownUrl) return "custom needs DECISION_BASE_URL, the server's address.";
    return "custom needs DECISION_MODEL, the model to ask.";
  }
  if (ownUrl && !decisions.apiKey)
    return `DECISION_BASE_URL is set, so the ${DECISION_VENDORS[name].label} key is not sent there: set DECISION_API_KEY for that address.`;
  if (name === "openai" && decisions.vendor === undefined)
    return "No decision model: set DECISION_PROVIDER to a vendor, or OPENAI_API_KEY for OpenAI's.";
  return `${name} needs ${DECISION_KEYS[name]}.`;
}

/** The decision vendor and its model, or why there is none. */
export function explainDecisionSetup(config: Config = getConfig()): KindSetup {
  const asked = config.decisions.vendor !== undefined || config.openai.apiKey !== undefined;
  const resolved = resolveDecisionEngine(config);
  if (!resolved) return { on: false, asked, reason: whyNoDecisionVendor(config) };
  const vendor = DECISION_VENDORS[resolved.name];
  const label = resolved.name === "custom" ? "System One server" : vendor.label;
  const model = resolved.model ?? (resolved.name === "openai" ? OPENAI_DECISIONS_MODEL : undefined);
  return {
    on: true,
    asked,
    vendor: label,
    where: shown(resolved.baseUrl),
    ...(model ? { model } : {}),
  };
}

/* - Embeddings -------------------------------------------------------------- */

/** Where the Playground's embeddings come from. Never off: the local hash needs nothing. */
export function explainEmbeddingSetup(config: Config = getConfig()): KindSetup {
  const { embeddings, openai } = config;
  const model = embeddings.model ?? openai.embeddingModel ?? DEFAULT_OPENAI_EMBEDDING_MODEL;
  if (embeddings.baseUrl)
    return {
      on: true,
      asked: true,
      vendor: "Embedding server",
      where: shown(embeddings.baseUrl),
      model,
    };
  if (embeddings.apiKey || openai.apiKey)
    return {
      on: true,
      asked: true,
      vendor: "OpenAI",
      where: shown(openai.baseUrl && !embeddings.apiKey ? openai.baseUrl : OPENAI_EMBEDDINGS_URL),
      model,
    };
  return { on: true, asked: false, vendor: "Local hashing (no outbound call)" };
}

/* - Startup ---------------------------------------------------------------- */

export interface SetupLine {
  level: "info" | "warn";
  message: string;
}

function modelCounts(features: FeatureSetup[]): string {
  const counts = new Map<string, number>();
  for (const row of features)
    if (row.model) counts.set(row.model, (counts.get(row.model) ?? 0) + 1);
  return [...counts].map(([model, count]) => `${model} (${count})`).join(", ");
}

/** One line per kind of model, for the startup log. */
export function setupLines(
  config: Config = getConfig(),
  environment: string = deploymentEnvironment(),
): SetupLine[] {
  const text = explainTextSetup(config, environment);
  const decisions = explainDecisionSetup(config);
  const embeddings = explainEmbeddingSetup(config);
  const lines: SetupLine[] = [];
  if (!text.on) {
    lines.push({
      level: text.asked ? "warn" : "info",
      message: `text models: off: ${text.reason}`,
    });
  } else {
    const missing = text.features.filter((row) => !row.model);
    const place = text.where ? ` at ${text.where}` : "";
    lines.push({
      level: missing.length > 0 ? "warn" : "info",
      message:
        `text models: ${text.vendor}${place}: ${modelCounts(text.features) || "no model named"}` +
        (missing.length > 0
          ? `; no model for ${missing.map((row) => row.feature).join(", ")}: set MODEL`
          : ""),
    });
  }
  lines.push(
    decisions.on
      ? {
          level: "info",
          message: `decision model: ${decisions.vendor}${decisions.model ? `, ${decisions.model}` : ""} at ${decisions.where}`,
        }
      : {
          level: decisions.asked ? "warn" : "info",
          message: `decision model: off: ${decisions.reason}`,
        },
  );
  const embedPlace = embeddings.where ? ` at ${embeddings.where}` : "";
  lines.push({
    level: "info",
    message: `embeddings: ${embeddings.vendor}${embeddings.model ? `, ${embeddings.model}` : ""}${embedPlace}`,
  });
  return lines;
}

/* - Failed calls ------------------------------------------------------------ */

export interface FailedCall {
  feature: string;
  model: string;
  error: unknown;
  /** Embeddings are not a feature of the table; the console's check names them. */
  kind?: "text" | "decision" | "embedding";
}

interface Hints {
  label: string;
  /** The setting the key came from, or the login. */
  key: string;
  /** Where a model lives: a location, a region. */
  place?: string;
  /** The address calls go to. */
  address?: string;
  /** The setting that names the model. */
  model: string;
  /** What to do when the account cannot use a model. */
  enable?: string;
  vendor?: VendorName | DecisionEngineName;
  region?: string;
}

function textHints(feature: string, config: Config, environment: string): Hints {
  const vendor = resolveModelVendor(config, environment);
  const own = config.modelVendor.features[feature];
  const variable = isFeature(feature) ? featureVariable(feature) : "MODEL_FEATURE_<FEATURE>";
  const model = own ? variable : `MODEL or ${variable}`;
  if (!vendor || vendor.name === "claude") {
    const bedrock = config.anthropic.backend === "bedrock";
    return bedrock
      ? {
          label: "Bedrock",
          key: "the AWS role this deployment runs as",
          model,
          vendor: "bedrock",
          ...(config.vendors.awsRegion ? { region: config.vendors.awsRegion } : {}),
        }
      : { label: "Claude", key: "ANTHROPIC_API_KEY", model, vendor: "claude" };
  }
  const label = VENDORS[vendor.name].label;
  switch (vendor.name) {
    case "gcp":
      return {
        label,
        key: "the Google login",
        place: `GOOGLE_CLOUD_LOCATION=${vendor.location}`,
        model,
        enable: "Enable it in Model Garden for this project, or pick a location that serves it.",
        vendor: vendor.name,
      };
    case "bedrock":
      return {
        label,
        key: vendor.apiKey ? "AWS_BEARER_TOKEN_BEDROCK" : "the AWS login",
        place: `AWS_REGION=${vendor.region}`,
        model,
        vendor: vendor.name,
        ...(vendor.region ? { region: vendor.region } : {}),
      };
    default: {
      const ownUrl = config.modelVendor.baseUrl;
      const hosted = Boolean(VENDORS[vendor.name].baseUrl);
      const key = config.modelVendor.apiKey || !hosted ? "MODEL_API_KEY" : "OPENAI_API_KEY";
      const address = vendor.baseUrl
        ? ownUrl
          ? `MODEL_BASE_URL=${shown(vendor.baseUrl)}`
          : shown(vendor.baseUrl)
        : undefined;
      return {
        label,
        key,
        ...(address ? { address } : {}),
        ...(address && ownUrl ? { place: address } : {}),
        model,
        vendor: vendor.name,
      };
    }
  }
}

function decisionHints(config: Config): Hints {
  const name = decisionVendorName(config) ?? "openai";
  const vendor = DECISION_VENDORS[name];
  const own = config.decisions.baseUrl;
  const base =
    own ??
    (name === "openai" ? (config.openai.baseUrl ?? OPENAI_DEFAULT_BASE_URL) : vendor.baseUrl);
  const address = base ? (own ? `DECISION_BASE_URL=${shown(base)}` : shown(base)) : undefined;
  return {
    label: name === "custom" ? "the System One server" : vendor.label,
    key: config.decisions.apiKey ? "DECISION_API_KEY" : DECISION_KEYS[name],
    ...(address ? { address } : {}),
    model: "DECISION_MODEL",
    vendor: name,
  };
}

function embeddingHints(config: Config): Hints {
  const own = config.embeddings.baseUrl;
  return {
    label: own ? "the embedding server" : "OpenAI",
    key: config.embeddings.apiKey ? "EMBEDDING_API_KEY" : "OPENAI_API_KEY",
    address: own
      ? `EMBEDDING_BASE_URL=${shown(own)}`
      : shown(config.openai.baseUrl ?? OPENAI_EMBEDDINGS_URL),
    model: "EMBEDDING_MODEL",
  };
}

/** The error and every cause under it, outermost first. */
function chain(error: unknown): unknown[] {
  const out: unknown[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && out.length < 6 && !out.includes(current)) {
    out.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return out;
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

function statusOf(errors: unknown[]): number | undefined {
  for (const error of errors) {
    const status = field(error, "status");
    if (typeof status === "number" && status >= 100 && status < 600) return status;
  }
  return undefined;
}

const text = (errors: unknown[]) =>
  errors
    .map(
      (error) => `${String(field(error, "name") ?? "")} ${String(field(error, "message") ?? "")}`,
    )
    .join(" ");

const isNamed = (errors: unknown[], pattern: RegExp) =>
  errors.some(
    (error) => pattern.test(String(field(error, "name") ?? "")) || pattern.test(className(error)),
  );

const CONNECTION_CODES =
  /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_VERIFY)/;

function isConnection(errors: unknown[]): boolean {
  return errors.some((error) => {
    const code = String(field(error, "code") ?? "");
    if (CONNECTION_CODES.test(code)) return true;
    const name = String(field(error, "name") ?? "");
    if (name === "APIConnectionError" || className(error) === "APIConnectionError") return true;
    return (
      error instanceof TypeError && /fetch failed|failed to fetch|network/i.test(error.message)
    );
  });
}

function className(error: unknown): string {
  if (error instanceof Error) return error.constructor?.name || error.name || "Error";
  return typeof error;
}

/**
 * One sentence about a failed call: who refused what, and the setting to fix. Built from settings,
 * vendor names, the model id and the status code alone.
 */
export function explainModelError(
  failed: FailedCall,
  options: { config?: Config; environment?: string } = {},
): string {
  const sentence = explain(failed, options);
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function explain(failed: FailedCall, options: { config?: Config; environment?: string }): string {
  const config = options.config ?? getConfig();
  const environment = options.environment ?? deploymentEnvironment();
  const kind =
    failed.kind ??
    (isFeature(failed.feature) && featureRow(failed.feature).kind === "decision"
      ? "decision"
      : "text");
  const hints =
    kind === "decision"
      ? decisionHints(config)
      : kind === "embedding"
        ? embeddingHints(config)
        : textHints(failed.feature, config, environment);
  const { label, model: modelSetting } = hints;
  const model = failed.model;
  const errors = chain(failed.error);
  const words = text(errors);
  const at = hints.address ? ` at ${hints.address}` : "";
  const inPlace =
    hints.place && !hints.place.startsWith("MODEL_BASE_URL") ? ` in ${hints.place}` : at;

  if (/invalid_grant|invalid_rapt|reauth|default credentials|application default/i.test(words))
    return `The Google login is missing or has expired, so ${label} can't be called. On this machine run: gcloud auth application-default login. On a server, give it a service account.`;
  if (
    isNamed(errors, /CredentialsProviderError|ExpiredToken/) ||
    /could not load credentials|security token included in the request is (invalid|expired)|ExpiredTokenException/i.test(
      words,
    )
  )
    return `The AWS login is missing or expired, so ${label} can't be called. Sign in again (aws sso login), give the server an IAM role, or set AWS_BEARER_TOKEN_BEDROCK.`;
  if (isNamed(errors, /^(TimeoutError|AbortError|APIConnectionTimeoutError)$/))
    return `${label} didn't answer in time for ${model}. A slow or busy server, or a model too large for it.`;
  if (isConnection(errors))
    return `Ratel couldn't reach ${label}${at}. Check the address, and that the server is running and reachable from Ratel's containers.`;

  let status = statusOf(errors);
  const reason = errors
    .map((error) => field(error, "reason"))
    .find((value) => typeof value === "string");
  if (status === undefined && reason === "credentials") status = 401;
  if (status === undefined && reason === "rate_limited") status = 429;
  const notAvailable =
    failed.error instanceof ModelNotEnabledError ||
    /not available for this account|aws.marketplace|model access|don't have access to the model|not authorized to (invoke|access) this model/i.test(
      words,
    );

  if (status === 403 && (hints.vendor === "bedrock" || notAvailable)) {
    const region = hints.region ? ` in ${hints.region}` : "";
    return `${label} won't run ${model} for this AWS account${region} (403). Enable it under Model access in the Bedrock console, or ask AWS for access; ${modelSetting} picks another model.`;
  }
  switch (status) {
    case 401:
      return `${label} refused the key in ${hints.key} (401). Check that it is the right key and has not expired.`;
    case 403:
      return `${label} refused ${model} (403): ${hints.key} has no access to it. Check the account's permissions, or pick another model with ${modelSetting}.`;
    case 404:
      return `${label} has no model ${model}${inPlace} (404), or this account can't use it. ${hints.enable ? `${hints.enable} ` : ""}Check ${modelSetting}.`;
    case 408:
      return `${label} didn't answer in time for ${model} (408).`;
    case 429:
      return `${label} is rate limiting ${model} or its quota ran out (429). Ratel retries; if it keeps happening, raise the quota.`;
    default:
      break;
  }
  if (status !== undefined && status >= 500)
    return `${label} had a server error (${status}) with ${model}. Ratel retries; it is the vendor's side.`;
  if (status !== undefined && status >= 400)
    return kind === "text"
      ? `${label} rejected the request for ${model} (${status}). The model may not take what Ratel asks for (tools, JSON); pick another with ${modelSetting}.`
      : `${label} rejected the request for ${model} (${status}). It may not serve that model: check ${modelSetting}.`;
  if (reason === "unreadable")
    return `${label} answered, but not in a form Ratel could read, for ${model}.`;
  return `${label} failed calling ${model} (${className(failed.error)}).`;
}
