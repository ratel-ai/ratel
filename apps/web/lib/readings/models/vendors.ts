import type { ModelTier } from "@/lib/contracts/models";

/**
 * Every vendor a deployment can name in `MODEL_PROVIDER` (ADR-0033 §3). A customer knows which
 * vendor they have an account with, not which wire format it speaks, so the vendor is the
 * setting and the format is this table's business.
 *
 * `models` are the vendor's nearest equivalents of the Claude models each tier runs on today
 * (deep Opus 5.5, standard Sonnet 5.5, fast Haiku 5.5). A vendor that serves Claude itself
 * (`servesClaude`) keeps the very same models. Every one can be changed: `MODEL_DEEP`,
 * `MODEL_STANDARD`, `MODEL_FAST`, and `MODEL_FEATURE_<FEATURE>` for one feature.
 */

export type VendorName =
  | "claude"
  | "openai"
  | "mistral"
  | "grok"
  | "gcp"
  | "bedrock"
  | "ollama"
  | "llama.cpp"
  | "vllm"
  | "litellm"
  | "custom"
  | "fake";

export interface Vendor {
  name: VendorName;
  /** As a person reads it. */
  label: string;
  /** Reached with an account and nothing else; the others are a server the customer runs or names. */
  hosted: boolean;
  /** Serves the Claude models, under their own names. */
  servesClaude?: boolean;
  /** The vendor's address. */
  baseUrl?: string;
  /** The variable that holds its key. */
  keyVariable?: string;
  /** A server's plain address gets this path. */
  path?: string;
  models?: Readonly<Record<ModelTier, string>>;
  /** Which recorded models a replay can run as they were. */
  replays?: RegExp;
  /** The vendor on a spend line, by OpenTelemetry's provider names where it has one. */
  provider: string;
}

const SERVER = { hosted: false, path: "/v1" } as const;

export const VENDORS: Readonly<Record<VendorName, Vendor>> = {
  claude: {
    name: "claude",
    label: "Claude",
    hosted: true,
    servesClaude: true,
    keyVariable: "ANTHROPIC_API_KEY",
    replays: /^claude-[a-z0-9.-]+$/i,
    provider: "anthropic",
  },
  // https://developers.openai.com/api/docs/models (checked 2026-11-23). Opus 5.5 sits between
  // Sol and Astra; the deep tier takes Astra so that it is never the weaker model. Sol and Luna
  // are priced as Sonnet 5.5 and Haiku 5.5 are.
  openai: {
    name: "openai",
    label: "OpenAI",
    hosted: true,
    baseUrl: "https://api.openai.com/v1",
    keyVariable: "OPENAI_API_KEY",
    models: { deep: "gpt-6.2-astra", standard: "gpt-6.2-sol", fast: "gpt-6-luna" },
    replays: /^(gpt-|chatgpt-|o\d)/i,
    provider: "openai",
  },
  // https://docs.mistral.ai/models (checked 2026-11-23). Medium is deprecated in favour of
  // Large 4, which is why Large serves two tiers.
  mistral: {
    name: "mistral",
    label: "Mistral",
    hosted: true,
    baseUrl: "https://api.mistral.ai/v1",
    keyVariable: "MISTRAL_API_KEY",
    models: {
      deep: "mistral-large-latest",
      standard: "mistral-large-latest",
      fast: "mistral-small-latest",
    },
    replays: /^(mistral|ministral|magistral|codestral|devstral)-/i,
    provider: "mistral_ai",
  },
  // https://docs.x.ai/developers/models (checked 2026-11-23). 4.3 is the cheapest current
  // general model, so it serves two tiers.
  grok: {
    name: "grok",
    label: "Grok (xAI)",
    hosted: true,
    baseUrl: "https://api.x.ai/v1",
    keyVariable: "XAI_API_KEY",
    models: { deep: "grok-4.7", standard: "grok-4.3", fast: "grok-4.3" },
    replays: /^grok-/i,
    provider: "x_ai",
  },
  gcp: {
    name: "gcp",
    label: "Google Cloud (Vertex AI)",
    hosted: true,
    servesClaude: true,
    replays: /^(claude|gemini)-[a-z0-9.-]+$/i,
    provider: "gcp.vertex_ai",
  },
  bedrock: {
    name: "bedrock",
    label: "Amazon Bedrock",
    hosted: true,
    servesClaude: true,
    replays: /^claude-[a-z0-9.-]+$/i,
    provider: "aws.bedrock",
  },
  ollama: { ...SERVER, name: "ollama", label: "Ollama", provider: "ollama" },
  "llama.cpp": { ...SERVER, name: "llama.cpp", label: "llama.cpp", provider: "llama.cpp" },
  vllm: { ...SERVER, name: "vllm", label: "vLLM", provider: "vllm" },
  litellm: { ...SERVER, name: "litellm", label: "LiteLLM", provider: "litellm" },
  custom: { name: "custom", label: "Another server", hosted: false, provider: "custom" },
  fake: { name: "fake", label: "Fake (tests)", hosted: false, provider: "fake" },
};

/** Other spellings of a vendor's name. */
const ALIASES: Readonly<Record<string, VendorName>> = {
  anthropic: "claude",
  llamacpp: "llama.cpp",
  "llama-cpp": "llama.cpp",
  xai: "grok",
};

/** The vendor a name means, or undefined: a name that is not in the table selects nothing. */
export function vendorNamed(name: string): Vendor | undefined {
  const lower = name.toLowerCase();
  if (Object.hasOwn(VENDORS, lower)) return VENDORS[lower as VendorName];
  return Object.hasOwn(ALIASES, lower) ? VENDORS[ALIASES[lower]] : undefined;
}

/** A Claude model, which a vendor that serves Claude answers in Claude's own format. */
export function isClaudeModel(model: string): boolean {
  return /^claude-/i.test(model) || /(^|\.)anthropic\./i.test(model);
}
