import type { CatalogFingerprintEntry } from "@/lib/synthesis/quality/schema";

/**
 * What retrieval saves, stated as a model rather than a measurement.
 *
 * Ratel's economic claim is simple: the agent gets `k` tool definitions instead
 * of the whole catalog. So the saving per search is the catalog the agent did
 * NOT have to carry. Everything here is arithmetic over that one sentence, and
 * every assumption behind it is exported so the page and the PDF can print them
 * rather than quietly bake them in.
 *
 * Two honesty rules are enforced by the types, not by discipline:
 *
 *  1. {@link TokenBasis} makes the estimate say whether it came from a character
 *     heuristic or from measured token counts. A modelled number and a measured
 *     one must never be shown in the same typeface without a label.
 *  2. {@link TokenSavings.realized} says whether the saving actually happened.
 *     A partner running Ratel purely in shadow is saving nothing today, because
 *     the agent still carries their whole catalog, so the honest word is "would
 *     save". Reporting a counterfactual as banked is the fastest way to lose a
 *     design partner's trust in every other number on the page.
 */

/**
 * Characters per token.
 *
 * Four is the long-standing rule of thumb for English prose, and it is used here
 * rather than a real tokenizer for a deliberate reason: a tokenizer would be a
 * new dependency, would have to be pinned per model family, and would move this
 * number every time a customer's model changed, for a figure that is a
 * comparison between two arms measured the same way. Both sides of every ratio
 * on this page use this constant, so it cancels.
 */
export const CHARS_PER_TOKEN = 4;

/** The default price assumption, in US dollars per million input tokens. */
export const DEFAULT_INPUT_PRICE_PER_MTOK = 3;

/**
 * What every saving figure is measured against, in one place.
 *
 * The comparison is the whole catalog in the prompt, NOT the other arm. That
 * distinction is easy to lose: both surfaces put the incumbent's search beside
 * ours on the same page, so a reader who sees "95% less prompt" next to a
 * legacy-vs-ratel latency chart will reasonably assume the saving is against
 * legacy. It is not. Legacy is a search engine, not a prompt budget; the thing
 * retrieval replaces is handing the model every tool.
 *
 * Kept as constants rather than retyped per surface so the console and the
 * partner report cannot drift into saying two different things.
 */
export const SAVINGS_BASELINE = "the full catalog";

export const SAVINGS_BASELINE_NOTE =
  "Every token and money figure here is measured against carrying the entire catalog in the prompt, not against the other arm.";

/** Whether a token figure was estimated from text or read from telemetry. */
export type TokenBasis = "modelled" | "measured";

export const BASIS_NOTES: Record<TokenBasis, string> = {
  modelled: `Estimated from the catalog text at ${CHARS_PER_TOKEN} characters per token. Both arms are estimated the same way, so the comparison holds even where the absolute figure drifts.`,
  measured: "Read from the tokens the agent's own model reported, not estimated.",
};

/** Rough token cost of a string. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * What one capability costs to put in front of an agent.
 *
 * The AGENT description, not the searchable one: the searchable text is what we
 * match on and the agent never sees it, so counting it here would inflate the
 * saving with text that was never in anyone's prompt. Schemas count because they
 * ship with the definition.
 */
export function entryPromptTokens(entry: {
  name: string;
  description: string;
  inputSchema?: unknown;
}): number {
  const schema = entry.inputSchema == null ? "" : JSON.stringify(entry.inputSchema);
  return estimateTokens(`${entry.name}\n${entry.description}\n${schema}`);
}

export interface SavingsInput {
  /** Prompt tokens for the entire catalog, if the agent carried all of it. */
  fullCatalogTokens: number;
  /** Mean number of results an arm returns per search. */
  averageReturned: number;
  /** Capabilities in the catalog. */
  entryCount: number;
  /** Searches in the window. */
  searchCount: number;
  basis?: TokenBasis;
  /** True only when this arm's results were actually served to the agent. */
  realized?: boolean;
  pricePerMtok?: number;
}

export interface TokenSavings {
  basis: TokenBasis;
  /** False when the arm only ever shadowed, so the saving is a counterfactual. */
  realized: boolean;
  fullCatalogTokens: number;
  /** Prompt tokens the agent carried per search under Ratel. */
  servedTokens: number;
  savedPerSearch: number;
  savedTotal: number;
  /** Share of the catalog's prompt cost avoided, in [0, 1]. */
  savedShare: number;
  pricePerMtok: number;
  savedUsd: number;
  searchCount: number;
}

/**
 * Scale the whole-catalog cost down by the share of it actually returned.
 *
 * Per-search exactness would need the definition of every id in every result
 * list, which is a second pass over the catalog per search for a figure whose
 * uncertainty is already dominated by {@link CHARS_PER_TOKEN}. The mean-length
 * approximation costs nothing and lands within a few percent, and the page says
 * it is modelled.
 */
export function estimateSavings(input: SavingsInput): TokenSavings {
  const {
    fullCatalogTokens,
    averageReturned,
    entryCount,
    searchCount,
    basis = "modelled",
    realized = false,
    pricePerMtok = DEFAULT_INPUT_PRICE_PER_MTOK,
  } = input;

  const returned = Math.max(0, Math.min(averageReturned, entryCount));
  const servedTokens =
    entryCount <= 0 ? 0 : Math.round(fullCatalogTokens * (returned / entryCount));
  const savedPerSearch = Math.max(0, fullCatalogTokens - servedTokens);
  const savedTotal = savedPerSearch * Math.max(0, searchCount);

  return {
    basis,
    realized,
    fullCatalogTokens,
    servedTokens,
    savedPerSearch,
    savedTotal,
    savedShare: fullCatalogTokens <= 0 ? 0 : savedPerSearch / fullCatalogTokens,
    pricePerMtok,
    savedUsd: (savedTotal / 1_000_000) * pricePerMtok,
    searchCount: Math.max(0, searchCount),
  };
}

/** Prompt tokens for a whole corpus, using each entry's agent description. */
export function catalogPromptTokens(
  entries: readonly CatalogFingerprintEntry[],
  descriptions: ReadonlyMap<string, { description: string; inputSchema?: unknown }>,
): number {
  let total = 0;
  for (const entry of entries) {
    const detail = descriptions.get(entry.entryId);
    total += entryPromptTokens({
      name: entry.name,
      // Falling back to the searchable text keeps a project whose agent
      // descriptions never reached Cloud from reporting a zero-token catalog,
      // which would read as "Ratel saves nothing" rather than "we don't know".
      description: detail?.description ?? entry.searchable,
      inputSchema: detail?.inputSchema,
    });
  }
  return total;
}

/**
 * The same saving, restated at the rate the window was running at.
 *
 * A partner does not think in "the 111 searches you sampled"; they think in
 * months. Extrapolating is a projection rather than a measurement, so it is a
 * separate function with `perMonth` in its name, and the surfaces label it as a
 * run rate rather than folding it into the measured total.
 */
export interface SavingsRunRate {
  searchesPerDay: number;
  searchesPerMonth: number;
  tokensPerMonth: number;
  usdPerMonth: number;
}

export const DAYS_PER_MONTH = 30;

export function projectMonthly(savings: TokenSavings, windowDays: number): SavingsRunRate | null {
  if (windowDays <= 0 || savings.searchCount <= 0) return null;
  const searchesPerDay = savings.searchCount / windowDays;
  const searchesPerMonth = searchesPerDay * DAYS_PER_MONTH;
  const tokensPerMonth = savings.savedPerSearch * searchesPerMonth;
  return {
    searchesPerDay,
    searchesPerMonth,
    tokensPerMonth,
    usdPerMonth: (tokensPerMonth / 1_000_000) * savings.pricePerMtok,
  };
}

/** How much faster one arm is than another, as a multiple. */
export function speedup(baselineMs: number | null, armMs: number | null): number | null {
  if (baselineMs === null || armMs === null) return null;
  if (!Number.isFinite(baselineMs) || !Number.isFinite(armMs)) return null;
  if (armMs <= 0 || baselineMs <= 0) return null;
  return baselineMs / armMs;
}
