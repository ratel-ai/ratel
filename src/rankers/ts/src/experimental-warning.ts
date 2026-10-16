// The OpenAI Decisions plugin's one-time beta nudge (OpenAI's API is in beta).
// Accesses `process`/`console` through `globalThis` so the module needs no
// `@types/node` and runs in any host (Node, workers, bundlers).

import { DEFAULT_OPENAI_DECISION_MODEL } from "../native/index.cjs";

const globalRef = globalThis as {
  console?: { warn?: (message: string) => void };
  process?: { env?: Record<string, string | undefined> };
};

let decisionWarned = false;

/**
 * Warn once per process that the OpenAI Decisions plugin is beta — unless
 * `RATEL_EXPERIMENTAL_SILENCE` is set. Called from
 * {@link ratelOpenAIDecisionPlugin} so the first plugin made trips it.
 * `model` is the model the plugin will ask, when it is not the default.
 */
export function warnOpenAIDecisionBetaOnce(model?: string): void {
  if (decisionWarned || globalRef.process?.env?.RATEL_EXPERIMENTAL_SILENCE) return;
  decisionWarned = true;
  const modelLine =
    model === undefined || model === DEFAULT_OPENAI_DECISION_MODEL
      ? `only ${DEFAULT_OPENAI_DECISION_MODEL} is supported.`
      : `only ${DEFAULT_OPENAI_DECISION_MODEL} is supported; this plugin asks ${model}.`;
  globalRef.console?.warn?.(
    "ratel: the OpenAI Decisions plugin is beta. OpenAI's Decisions API is in public beta and " +
      `may change; ${modelLine} It ranks tools and skills only (no facts, text only). Ratel caps ` +
      "each question at 150 choices / 80,000 characters (OpenAI allows 2 to 255 choices). The query " +
      "and each candidate's text are sent to OpenAI. " +
      "Set RATEL_EXPERIMENTAL_SILENCE=1 to silence this warning.",
  );
}

/** Reset the Decisions plugin's one-time guard. Test-only. */
export function resetOpenAIDecisionWarningForTest(): void {
  decisionWarned = false;
}
