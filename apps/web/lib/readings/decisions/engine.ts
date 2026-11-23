import { RATEL_BUDGET_PRICES } from "@/lib/ingest/pricing";
import { configured } from "@/lib/platform/env-configured";
import { getLogger } from "@/lib/platform/logger";
import { FALLBACK_PRICE_MODEL, priceOverrides } from "@/lib/readings/models/prices";
import { OPENAI_DEFAULT_BASE_URL, OPENAI_USD_PER_INPUT_TOKEN } from "./openai";
import { DECISION_VENDORS, type DecisionVendorName, decisionVendorNamed } from "./vendors";

/**
 * Which decision model answers the closed-set questions: the match-quality judge, Agent
 * health's workflow decisions, the topics placement. Without a usable vendor none runs and
 * every feature that would ask one reports itself as not measured.
 *
 * `DECISION_PROVIDER` names the vendor (ADR-0033 §9, `vendors.ts`): `openai`, `typesafe`,
 * `levanto`, `google`, or `custom` for another server that speaks the System One format. Each
 * takes its own key variable; `DECISION_API_KEY` is ahead of it, `DECISION_MODEL` names another
 * model, and `DECISION_BASE_URL` another address. A named vendor is used or nothing is, a name
 * the table does not have selects nothing, and a vendor's key is sent to that vendor only.
 *
 * Unset is OpenAI's Decisions API with `OPENAI_API_KEY` and `OPENAI_BASE_URL`, as before.
 * `DECISION_ENGINE` is the private edition's setting for its own calls (ADR-0030): here it
 * selects nothing, and any name but `openai` is warned about once.
 */

export type DecisionEngineName = DecisionVendorName;

export const DEFAULT_DECISION_ENGINE: DecisionEngineName = "openai";

type Env = Record<string, string | undefined>;

const logger = getLogger("decisions/engine");
let warnedUnknown = false;

export { configured } from "@/lib/platform/env-configured";

export interface ResolvedDecisionEngine {
  name: DecisionEngineName;
  /** Empty for a custom server that asks for none. */
  apiKey: string;
  baseUrl: string;
  /** The model the deployment names. Absent leaves the OpenAI engine's own default. */
  model?: string;
}

/** The vendor the environment names; null for a name that is not a vendor. */
export function preferredDecisionEngine(env: Env = process.env): DecisionEngineName | null {
  const named = configured(env.DECISION_PROVIDER);
  if (named !== undefined) return decisionVendorNamed(named)?.name ?? null;
  const legacy = configured(env.DECISION_ENGINE)?.toLowerCase();
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
export function resolveDecisionEngine(env: Env = process.env): ResolvedDecisionEngine | null {
  const name = preferredDecisionEngine(env);
  if (!name) return null;
  const vendor = DECISION_VENDORS[name];
  const ownUrl = configured(env.DECISION_BASE_URL);
  const ownKey = configured(env.DECISION_API_KEY);
  // A vendor's key is not sent to another address.
  const apiKey = ownKey ?? (ownUrl ? undefined : configured(env[vendor.keyVariable ?? ""]));
  const ownModel = configured(env.DECISION_MODEL);

  if (name === "openai") {
    if (!apiKey) return null;
    const legacyUrl = ownKey ? undefined : configured(env.OPENAI_BASE_URL);
    const model = ownModel ?? configured(env.OPENAI_DECISIONS_MODEL);
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
export function decisionEngineConfigured(env: Env = process.env): boolean {
  return resolveDecisionEngine(env) !== null;
}

/**
 * The price per input token, for turning a dollar cap into a token cap: `MODEL_PRICES` for a
 * model it names, else the vendor's list price. A model neither prices is charged at the fallback
 * rate, so a dollar cap allows fewer questions, never more.
 */
export function usdPerInputToken(name: DecisionEngineName, env: Env = process.env): number {
  if (name === "openai") return OPENAI_USD_PER_INPUT_TOKEN;
  const vendor = DECISION_VENDORS[name];
  const named = configured(env.DECISION_MODEL);
  const own = priceOverrides(env)[named ?? vendor.model ?? ""];
  if (own) return own.input / 1_000_000;
  // A vendor's price is its own model's; another model it serves may cost more.
  const listed = !named || named === vendor.model ? vendor.usdPerInputToken : undefined;
  return listed ?? RATEL_BUDGET_PRICES[FALLBACK_PRICE_MODEL].input / 1_000_000;
}
