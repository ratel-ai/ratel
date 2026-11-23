import { configured } from "@/lib/platform/env-configured";
import { getLogger } from "@/lib/platform/logger";
import { OPENAI_DEFAULT_BASE_URL, OPENAI_USD_PER_INPUT_TOKEN } from "./openai";

/**
 * Which decision model answers the closed-set questions: the match-quality judge, Agent
 * health's workflow decisions, the topics placement. The open-source edition ships one
 * engine, OpenAI's Decisions API, keyed by `OPENAI_API_KEY`; without a key no engine
 * runs and every feature that would ask one reports itself as not measured. The Cloud
 * edition's other engines are private (ADR-0004).
 *
 * `DECISION_ENGINE` is honoured for compatibility: `openai` or unset selects it, any
 * other name logs a warning once and is ignored.
 */

export type DecisionEngineName = "openai";

export const DEFAULT_DECISION_ENGINE: DecisionEngineName = "openai";

const KEY_VARIABLE = "OPENAI_API_KEY";

type Env = Record<string, string | undefined>;

const logger = getLogger("decisions/engine");
let warnedUnknown = false;

export { configured } from "@/lib/platform/env-configured";

export interface ResolvedDecisionEngine {
  name: DecisionEngineName;
  apiKey: string;
  baseUrl: string;
}

/** The engine `DECISION_ENGINE` asks for, read leniently: the one engine, or a warning. */
export function preferredDecisionEngine(env: Env = process.env): DecisionEngineName {
  const raw = configured(env.DECISION_ENGINE)?.toLowerCase();
  if (raw !== undefined && raw !== DEFAULT_DECISION_ENGINE && !warnedUnknown) {
    warnedUnknown = true;
    logger.warn(
      { engine: raw, using: DEFAULT_DECISION_ENGINE },
      "decision engine is not available in this edition",
    );
  }
  return DEFAULT_DECISION_ENGINE;
}

/** The engine to run and its key, or null when no engine is usable. */
export function resolveDecisionEngine(env: Env = process.env): ResolvedDecisionEngine | null {
  const name = preferredDecisionEngine(env);
  const apiKey = configured(env[KEY_VARIABLE]);
  if (!apiKey) return null;
  return { name, apiKey, baseUrl: configured(env.OPENAI_BASE_URL) ?? OPENAI_DEFAULT_BASE_URL };
}

/** True when a decision engine can run. */
export function decisionEngineConfigured(env: Env = process.env): boolean {
  return resolveDecisionEngine(env) !== null;
}

/** The engine's list price per input token, for turning a dollar cap into a token cap. */
export function usdPerInputToken(_name: DecisionEngineName): number {
  return OPENAI_USD_PER_INPUT_TOKEN;
}
