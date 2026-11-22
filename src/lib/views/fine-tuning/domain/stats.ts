import type { ResolvedTurn } from "../resolve";

/**
 * Is a use case worth a small model (RC-1125)? How many runs it has, which
 * model it uses now and what a run costs.
 *
 * Costs are the stored call costs (`events.cost_usd`): the project's price
 * book priced them at ingest and the re-price keeps them current, and
 * `get_cost_by_day` sums the same numbers. Nothing is priced here. A call
 * with no stored cost is Unpriced: a run with one is left out of the cost per
 * run, never counted as $0. A run with no matched call is not a priced run.
 */

export interface UseCaseStats {
  /** Every matched turn in the window. */
  turns: number;
  /** The matched model calls of the turns read (all of them unless `sampled`). */
  calls: number;
  firstEndedAt: string | null;
  lastEndedAt: string | null;
  /** The most used model of the matched calls; a tie goes to the one used last. */
  currentModel: string | null;
  /** The mean cost of the priced runs; null (Unpriced) when no run is priced. */
  costPerRunUsd: number | null;
  /** The runs the cost per run averages: at least one call, every call priced. */
  pricedRuns: number;
  unpricedCalls: number;
  /** More turns matched than were read: calls, model and cost come from the newest ones. */
  sampled: boolean;
}

/** The turn totals over the whole window, read apart from the calls. */
export interface TurnTotals {
  turns: number;
  firstEndedAt: Date | null;
  lastEndedAt: Date | null;
}

export function statsOfUseCase(turns: readonly ResolvedTurn[], totals: TurnTotals): UseCaseStats {
  const calls = turns.flatMap((turn) => turn.calls);
  const priced = turns.filter(
    (turn) => turn.calls.length > 0 && turn.calls.every((call) => call.costUsd !== null),
  );
  const cost = priced.reduce(
    (sum, turn) => sum + turn.calls.reduce((total, call) => total + (call.costUsd ?? 0), 0),
    0,
  );
  return {
    turns: totals.turns,
    calls: calls.length,
    firstEndedAt: totals.firstEndedAt?.toISOString() ?? null,
    lastEndedAt: totals.lastEndedAt?.toISOString() ?? null,
    currentModel: mostUsedModel(calls),
    costPerRunUsd: priced.length > 0 ? roundUsd(cost / priced.length) : null,
    pricedRuns: priced.length,
    unpricedCalls: calls.filter((call) => call.costUsd === null).length,
    sampled: totals.turns > turns.length,
  };
}

function mostUsedModel(
  calls: readonly { model: string | null; occurredAt: Date }[],
): string | null {
  const counts = new Map<string, { count: number; last: number }>();
  for (const call of calls) {
    if (!call.model) continue;
    const entry = counts.get(call.model) ?? { count: 0, last: 0 };
    counts.set(call.model, {
      count: entry.count + 1,
      last: Math.max(entry.last, call.occurredAt.getTime()),
    });
  }
  let best: [string, { count: number; last: number }] | null = null;
  for (const entry of counts) {
    if (
      !best ||
      entry[1].count > best[1].count ||
      (entry[1].count === best[1].count && entry[1].last > best[1].last)
    )
      best = entry;
  }
  return best?.[0] ?? null;
}

/** The stored cost precision, `numeric(12,6)`. */
function roundUsd(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}
