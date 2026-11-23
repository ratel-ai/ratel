import { type Config, getConfig } from "@/config";
import { RATEL_BUDGET_PRICES } from "@/lib/ingest/pricing";
import { getLogger } from "@/lib/platform/logger";
import { FALLBACK_PRICE_MODEL, priceOverrides } from "@/lib/readings/models/prices";
import { OPENAI_DEFAULT_BASE_URL, OPENAI_USD_PER_INPUT_TOKEN } from "./openai";
import { DECISION_VENDORS, type DecisionVendorName, decisionVendorNamed } from "./vendors";

/**
 * Which decision model answers the closed-set questions: the match-quality judge, Agent
 * health's workflow decisions, the topics placement. Without a usable vendor none runs and
 * every feature that would ask one reports itself as not measured.
 *
 * `decisions.vendor` (DECISION_PROVIDER) names the vendor (ADR-0009 §9, `vendors.ts`): `openai`,
 * `typesafe`, `levanto`, `google`, or `custom` for another server that speaks the System One
 * format. Each has its own key; `decisions.apiKey` is ahead of it, `decisions.model` names another
 * model, and `decisions.baseUrl` another address. A named vendor is used or nothing is, a name the
 * table does not have selects nothing, and a vendor's key is sent to that vendor only.
 *
 * Unset is OpenAI's Decisions API with `openai.apiKey` (OPENAI_API_KEY) and `openai.baseUrl`, as
 * before. `openai.decisionEngine` (DECISION_ENGINE) is the private edition's setting for its own
 * calls: here it selects nothing, and any name but `openai` is warned about once.
 */

export type DecisionEngineName = DecisionVendorName;

export const DEFAULT_DECISION_ENGINE: DecisionEngineName = "openai";

const logger = getLogger("decisions/engine");
let warnedUnknown = false;

export interface ResolvedDecisionEngine {
  name: DecisionEngineName;
  /** Empty for a custom server that asks for none. */
  apiKey: string;
  baseUrl: string;
  /** The model the deployment names. Absent leaves the OpenAI engine's own default. */
  model?: string;
}

/** The vendor the settings name; null for a name that is not a vendor. */
export function preferredDecisionEngine(
  config: Pick<Config, "openai" | "decisions"> = getConfig(),
): DecisionEngineName | null {
  const named = config.decisions.vendor;
  if (named !== undefined) return decisionVendorNamed(named)?.name ?? null;
  const legacy = config.openai.decisionEngine?.toLowerCase();
  if (legacy !== undefined && legacy !== DEFAULT_DECISION_ENGINE && !warnedUnknown) {
    warnedUnknown = true;
    logger.warn(
      { engine: legacy, using: DEFAULT_DECISION_ENGINE },
      "DECISION_ENGINE selects nothing here; name the vendor in DECISION_PROVIDER",
    );
  }
  return DEFAULT_DECISION_ENGINE;
}

/** The vendor to ask and where it is, or null when none is usable. */
export function resolveDecisionEngine(config: Config = getConfig()): ResolvedDecisionEngine | null {
  const { decisions, openai } = config;
  const name = preferredDecisionEngine(config);
  if (!name) return null;
  const vendor = DECISION_VENDORS[name];
  const ownUrl = decisions.baseUrl;
  const ownKey = decisions.apiKey;
  // A vendor's key is not sent to another address.
  const apiKey = ownKey ?? (ownUrl ? undefined : vendor.key?.(config));
  const ownModel = decisions.model;

  if (name === "openai") {
    if (!apiKey) return null;
    const legacyUrl = ownKey ? undefined : openai.baseUrl;
    const model = ownModel ?? openai.decisionsModel;
    return {
      name,
      apiKey,
      baseUrl: ownUrl ?? legacyUrl ?? OPENAI_DEFAULT_BASE_URL,
      ...(model ? { model } : {}),
    };
  }
  const baseUrl = ownUrl ?? vendor.baseUrl;
  const model = ownModel ?? vendor.model;
  if (!baseUrl || !model) return null;
  // Only a server the deployment runs may ask for no key.
  if (!apiKey && name !== "custom") return null;
  return { name, apiKey: apiKey ?? "", baseUrl, model };
}

/** True when a decision vendor can be asked. */
export function decisionEngineConfigured(config: Config = getConfig()): boolean {
  return resolveDecisionEngine(config) !== null;
}

/**
 * The price per input token, for turning a dollar cap into a token cap: `modelVendor.prices` for a
 * model it names, else the vendor's list price. A model neither prices is charged at the fallback
 * rate, so a dollar cap allows fewer questions, never more.
 */
export function usdPerInputToken(name: DecisionEngineName, config: Config = getConfig()): number {
  if (name === "openai") return OPENAI_USD_PER_INPUT_TOKEN;
  const vendor = DECISION_VENDORS[name];
  const named = config.decisions.model;
  const own = priceOverrides(config)[named ?? vendor.model ?? ""];
  if (own) return own.input / 1_000_000;
  // A vendor's price is its own model's; another model it serves may cost more.
  const listed = !named || named === vendor.model ? vendor.usdPerInputToken : undefined;
  return listed ?? RATEL_BUDGET_PRICES[FALLBACK_PRICE_MODEL].input / 1_000_000;
}
