// One-time "this API is experimental" nudges: the facts / grounding surface,
// and the OpenAI Decisions plugin (OpenAI's API is in beta).
// Accesses `process`/`console` through `globalThis` so the module needs no
// `@types/node` and runs in any host (Node, workers, bundlers).

const globalRef = globalThis as {
  console?: { warn?: (message: string) => void };
  process?: { env?: Record<string, string | undefined> };
};

let warned = false;

/**
 * Warn once per process that the facts / grounding API is experimental — unless
 * `RATEL_EXPERIMENTAL_SILENCE` is set. Called from {@link FactCatalog}'s
 * constructor so any entry into the feature trips it exactly once.
 */
export function warnExperimentalFactsOnce(): void {
  if (warned || globalRef.process?.env?.RATEL_EXPERIMENTAL_SILENCE) return;
  warned = true;
  globalRef.console?.warn?.(
    "ratel: the facts / grounding API is experimental and may change without a major-version " +
      'bump — import it from the `experimental` namespace (`import { experimental } from "@ratel-ai/sdk"`). ' +
      "Set RATEL_EXPERIMENTAL_SILENCE=1 to silence this warning.",
  );
}

/**
 * Reset the one-time guard. Test-only — lets a test assert the warning fires
 * without another test having already tripped the process-wide flag.
 */
export function resetExperimentalWarningForTest(): void {
  warned = false;
}

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
    model === undefined || model === "gpt-6-luna"
      ? "only gpt-6-luna is supported."
      : `only gpt-6-luna is supported; this plugin asks ${model}.`;
  globalRef.console?.warn?.(
    "ratel: the OpenAI Decisions plugin is beta. OpenAI's Decisions API is in public beta and " +
      `may change; ${modelLine} It ranks tools and skills only (no facts, text only). Ratel caps ` +
      "each question at 150 choices / 80,000 characters (OpenAI documents no limits). The query " +
      "and each candidate's text are sent to OpenAI. " +
      "Set RATEL_EXPERIMENTAL_SILENCE=1 to silence this warning.",
  );
}

/** Reset the Decisions plugin's one-time guard. Test-only. */
export function resetOpenAIDecisionWarningForTest(): void {
  decisionWarned = false;
}
