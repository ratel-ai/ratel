import type { LinkedDay } from "@/lib/readings/trace-signals/signals/linked-day";

/**
 * What one model round-trip costs this project, read off the signal run's
 * day buckets: the SDK runs linked to their OpenTelemetry model calls carry
 * the calls' summed duration and, where the model has a price, their cost.
 * A suggestion that removes a tool call removes the round-trip that waited
 * for it, so the gain of "one call fewer" is the tool's time plus this.
 * Null fields mean the project has no linked model calls (or no priced
 * ones): the page then counts round-trips and says nothing in seconds or
 * dollars for them.
 */
export interface RoundTripPrice {
  /** Median-ish model-call duration (summed ms over summed calls). */
  ms: number | null;
  /** Cost of one model call in USD, over the priced runs. */
  usd: number | null;
  /** Tokens one model call reads and writes, on average; null on buckets stored before tokens were kept. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** Linked model calls behind the figures. */
  modelCalls: number;
}

export const NO_PRICE: RoundTripPrice = {
  ms: null,
  usd: null,
  inputTokens: null,
  outputTokens: null,
  modelCalls: 0,
};

export function roundTripPriceOf(daily: readonly { linked?: LinkedDay }[]): RoundTripPrice {
  let runs = 0;
  let calls = 0;
  let ms = 0;
  let pricedRuns = 0;
  let usd = 0;
  let inTok = 0;
  let outTok = 0;
  for (const day of daily) {
    const l = day.linked;
    if (!l) continue;
    runs += l.runs;
    calls += l.modelCalls;
    ms += l.modelMs ?? 0;
    pricedRuns += l.pricedRuns;
    usd += l.costUsd;
    inTok += l.inputTokens ?? 0;
    outTok += l.outputTokens ?? 0;
  }
  if (calls === 0) return NO_PRICE;
  // Cost is summed over priced runs only; the calls of those runs are taken as their share of all linked calls.
  const pricedCalls = runs > 0 ? calls * (pricedRuns / runs) : 0;
  return {
    ms: ms > 0 ? ms / calls : null,
    usd: pricedCalls > 0 ? usd / pricedCalls : null,
    inputTokens: inTok + outTok > 0 ? inTok / calls : null,
    outputTokens: inTok + outTok > 0 ? outTok / calls : null,
    modelCalls: calls,
  };
}

/** The baseline every window figure rests on, said once: "942 model calls in this window: 6.3k tokens, 2.8 s and $0.021 each". Null without linked calls. */
export function describePrice(price: RoundTripPrice): string | null {
  if (price.modelCalls === 0) return null;
  const parts: string[] = [];
  if (price.inputTokens !== null && price.outputTokens !== null)
    parts.push(`${fmtTokens(price.inputTokens + price.outputTokens)} tokens`);
  if (price.ms !== null)
    parts.push(
      price.ms >= 1000 ? `${(price.ms / 1000).toFixed(1)} s` : `${Math.round(price.ms)} ms`,
    );
  if (price.usd !== null)
    parts.push(price.usd >= 1 ? `$${price.usd.toFixed(2)}` : `$${price.usd.toFixed(3)}`);
  const each = parts.length > 0 ? `: ${parts.join(", ")} each` : "; neither timed nor priced";
  return `Priced from ${price.modelCalls.toLocaleString("en-US")} model calls the agent made in this window${each}.`;
}

const fmtTokens = (n: number): string =>
  n >= 10_000
    ? `${Math.round(n / 1000)}k`
    : n >= 1_000
      ? `${(n / 1000).toFixed(1)}k`
      : String(Math.round(n));
