import { RATEL_BUDGET_PRICES } from "@/lib/ingest/pricing";
import { configured } from "@/lib/platform/env-configured";
import { getLogger } from "@/lib/platform/logger";
import { FALLBACK_PRICE_MODEL, priceOverrides } from "@/lib/readings/models/prices";
import { OPENAI_DEFAULT_BASE_URL, OPENAI_USD_PER_INPUT_TOKEN } from "./openai";

/**
 * Which decision model answers the closed-set questions: the match-quality judge, Agent
 * health's workflow decisions, the topics placement. Without a usable engine none runs and
 * every feature that would ask one reports itself as not measured.
 *
 * `DECISION_ENGINE` picks it (ADR-0033):
 *   - `openai` or unset: OpenAI's Decisions API. `DECISION_API_KEY` and `DECISION_BASE_URL`
 *     select the server when either is set; otherwise `OPENAI_API_KEY` and `OPENAI_BASE_URL`,
 *     as before. `DECISION_MODEL`, then `OPENAI_DECISIONS_MODEL`, names the model.
 *   - `system-one`: any server that speaks the System One wire format (`system-one.ts`). It
 *     needs `DECISION_BASE_URL` and `DECISION_MODEL`; `DECISION_API_KEY` when the server asks
 *     for one. It never falls back to the OpenAI key or engine.
 *
 * A key goes only to the server it was set for: `OPENAI_API_KEY` is never sent to
 * `DECISION_BASE_URL`.
 *
 * Any other name logs a warning once and is read as `openai`. That leniency is kept on
 * purpose: Ratel's own deployments set the names of the Cloud edition's private engines
 * (ADR-0030), and the core must keep judging there.
 */

export type DecisionEngineName = "openai" | "system-one";

export const DEFAULT_DECISION_ENGINE: DecisionEngineName = "openai";

type Env = Record<string, string | undefined>;

const logger = getLogger("decisions/engine");
let warnedUnknown = false;

export { configured } from "@/lib/platform/env-configured";

export interface ResolvedDecisionEngine {
  name: DecisionEngineName;
  /** Empty for a `system-one` server that asks for none. */
  apiKey: string;
  baseUrl: string;
  /** The model the deployment names. Absent leaves the engine's own default. */
  model?: string;
}

/** The engine `DECISION_ENGINE` asks for, read leniently: a known name, or `openai` with a warning. */
export function preferredDecisionEngine(env: Env = process.env): DecisionEngineName {
  const raw = configured(env.DECISION_ENGINE)?.toLowerCase();
  if (raw === "system-one") return raw;
  if (raw !== undefined && raw !== DEFAULT_DECISION_ENGINE && !warnedUnknown) {
    warnedUnknown = true;
    logger.warn(
      { engine: raw, using: DEFAULT_DECISION_ENGINE },
      "decision engine is not available in this edition",
    );
  }
  return DEFAULT_DECISION_ENGINE;
}

/** The engine to run and where it is, or null when no engine is usable. */
export function resolveDecisionEngine(env: Env = process.env): ResolvedDecisionEngine | null {
  const name = preferredDecisionEngine(env);
  const ownBaseUrl = configured(env.DECISION_BASE_URL);
  const ownKey = configured(env.DECISION_API_KEY);
  const ownModel = configured(env.DECISION_MODEL);

  if (name === "system-one") {
    if (!ownBaseUrl || !ownModel) return null;
    return { name, apiKey: ownKey ?? "", baseUrl: ownBaseUrl, model: ownModel };
  }

  const model = ownModel ?? configured(env.OPENAI_DECISIONS_MODEL);
  if (ownBaseUrl || ownKey) {
    if (!ownKey) return null;
    return {
      name,
      apiKey: ownKey,
      baseUrl: ownBaseUrl ?? OPENAI_DEFAULT_BASE_URL,
      ...(model ? { model } : {}),
    };
  }
  const apiKey = configured(env.OPENAI_API_KEY);
  if (!apiKey) return null;
  return {
    name,
    apiKey,
    baseUrl: configured(env.OPENAI_BASE_URL) ?? OPENAI_DEFAULT_BASE_URL,
    ...(model ? { model } : {}),
  };
}

/** True when a decision engine can run. */
export function decisionEngineConfigured(env: Env = process.env): boolean {
  return resolveDecisionEngine(env) !== null;
}

/**
 * The engine's price per input token, for turning a dollar cap into a token cap. OpenAI's is
 * its list price. Another engine's model is priced by `MODEL_PRICES`; unpriced, it is charged
 * at the fallback rate, so a dollar cap allows fewer questions, never more.
 */
export function usdPerInputToken(name: DecisionEngineName, env: Env = process.env): number {
  if (name === "openai") return OPENAI_USD_PER_INPUT_TOKEN;
  const model = configured(env.DECISION_MODEL);
  const own = model ? priceOverrides(env)[model] : undefined;
  return (own ?? RATEL_BUDGET_PRICES[FALLBACK_PRICE_MODEL]).input / 1_000_000;
}
