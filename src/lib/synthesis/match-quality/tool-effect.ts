import type { EntryEffect } from "./replay";

/**
 * What one rewrite does for the tool it rewrites, for that tool's card.
 *
 * The card used to print the rewrite's effect on the WHOLE catalog: every
 * tool's searches, before and after. That answers "is the catalog better" and
 * hides the question a reader has in front of one proposal, which is "does this
 * tool now show up when it is the right answer?". A tool that goes from 19 of
 * 28 to 28 of 28 reads as "+2 points" on a 389-search population, which says
 * nothing about the tool.
 *
 * So the headline is the tool's own searches: how many of them had it in the
 * list the agent saw, before and after. The whole-catalog figure stays in the
 * run's panel, where "apply all" is the action.
 *
 * The change is printed as a percentage ("+18%"): the tool's hit rate moving
 * from 66% to 84% of its searches. It is a difference in the rate, not a
 * relative increase, and the raw counts sit beside it so it cannot be misread.
 *
 * Collateral damage to other tools is not printed here. It is still guarded: a
 * draft whose replay loses ground across the catalog is discarded before it is
 * offered (see `pipeline.ts:costsQuality`), and the run's panel lists any
 * regressions.
 */

export interface ToolEffectView {
  /** Searches whose right answer was this tool. */
  n: number;
  containedBefore: number;
  containedAfter: number;
  /** "68%" and "100%". */
  beforePercent: string;
  afterPercent: string;
  /** "+18%", "−5%", or "No change". */
  delta: string;
  direction: "up" | "down" | "flat";
}

/**
 * The per-tool view of one proposal's stored replay, or null.
 *
 * Null when the result predates per-entry in-list counts, or the tool had no
 * replayable searches. The card then falls back to what it printed before.
 */
export function toolEffectView(raw: unknown, entryId: string): ToolEffectView | null {
  if (typeof raw !== "object" || raw === null) return null;
  const effects = (raw as { byEntry?: unknown }).byEntry;
  if (!Array.isArray(effects)) return null;

  const own = effects.find(
    (effect): effect is EntryEffect => isEffect(effect) && effect.entryId === entryId,
  );
  if (!own || own.n <= 0) return null;
  if (typeof own.containedBefore !== "number" || typeof own.containedAfter !== "number") {
    return null;
  }

  const before = own.containedBefore / own.n;
  const after = own.containedAfter / own.n;
  const change = Math.round((after - before) * 100);

  return {
    n: own.n,
    containedBefore: own.containedBefore,
    containedAfter: own.containedAfter,
    beforePercent: `${Math.round(before * 100)}%`,
    afterPercent: `${Math.round(after * 100)}%`,
    delta: change === 0 ? "No change" : `${change > 0 ? "+" : "−"}${Math.abs(change)}%`,
    direction: change === 0 ? "flat" : change > 0 ? "up" : "down",
  };
}

function isEffect(value: unknown): value is EntryEffect {
  if (typeof value !== "object" || value === null) return false;
  const effect = value as Record<string, unknown>;
  return (
    typeof effect.entryId === "string" &&
    typeof effect.n === "number" &&
    typeof effect.lost === "number"
  );
}

/**
 * How often production had this tool in the list when it was the answer, in
 * the run's own window, from the lists actually served. No replay involved.
 *
 * Printed beside the replay's numbers because the replay is keyword-only and
 * usually finds the tool LESS often than production does; without this a reader
 * takes the replay's "before" for how the tool is doing today. Null when the
 * evidence carries no counts.
 */
export function servedInList(evidence: unknown): { contained: number; n: number } | null {
  if (typeof evidence !== "object" || evidence === null) return null;
  const record = evidence as Record<string, unknown>;
  const targeted = record.targeted;
  const misses = record.misses;
  if (typeof targeted !== "number" || typeof misses !== "number" || targeted <= 0) return null;
  return { contained: Math.max(0, targeted - misses), n: targeted };
}
