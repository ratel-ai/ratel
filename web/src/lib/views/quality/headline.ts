import { wilsonInterval } from "@/lib/readings/stats";
import type { EvaluableSelection } from "@/lib/synthesis/quality/ground-truth";
import { separated } from "@/lib/synthesis/quality/metrics";
import { type Change, plural, pointChange } from "./model";

/**
 * "Right tool first", on one evidence tier and never a blend: the quality
 * meter's rule (lib/quality/headline.ts), and every place it shows names it.
 *
 * - Judged: the answer key's own verdicts, decided apart from every ranking.
 * - Seen it run: the tool the agent ran, counted only where our list was NOT
 *   the one it was shown (an independent variant).
 *
 * A tool the agent ran from our own list never counts: it could only pick
 * from what we showed it and leans on the first result, so scoring us against
 * it restates the setup. Those searches still appear in Misses, labelled.
 * Judged leads whenever it has any searches; Seen it run only without them.
 */

export type ShareTier = "judged" | "seen";

export const TIER_LABEL: Record<ShareTier, string> = { judged: "Judged", seen: "Seen it run" };

/** Below this many searches the share is noise, so none is shown and neither is a change. */
export const MIN_SHARE_SAMPLE = 10;

/** Below this many searches a trend bucket is a gap, not a point. */
export const MIN_BUCKET_SAMPLE = 3;

const DAY_MS = 86_400_000;

export interface TierObservation {
  occurredAt: Date;
  /** Where our ranking put the tier's right tool, 1-based, or null when we did not return it. */
  rank: number | null;
}

export interface TierSets {
  judged: TierObservation[];
  seen: TierObservation[];
}

/** Every search the share may stand on, per tier. A search can sit in both; only one tier is ever read. */
export function tierObservations(
  selections: readonly EvaluableSelection[],
  ourArm: string,
): TierSets {
  const judged: TierObservation[] = [];
  const seen: TierObservation[] = [];
  for (const selection of selections) {
    const ours = selection.arms.find((arm) => arm.arm === ourArm);
    if (!ours) continue;
    const rankOf = (target: string) => {
      const index = ours.resultIds.indexOf(target);
      return index === -1 ? null : index + 1;
    };
    const verdict = selection.unclear ? null : (selection.judgedToolId ?? null);
    if (verdict && selection.judgedFrom !== "invoked") {
      judged.push({ occurredAt: selection.occurredAt, rank: rankOf(verdict) });
    }
    const ran =
      selection.invokedToolId ??
      (selection.judgedFrom === "invoked" ? (selection.judgedToolId ?? null) : null);
    if (ran && ours.role !== "serving") {
      seen.push({ occurredAt: selection.occurredAt, rank: rankOf(ran) });
    }
  }
  return { judged, seen };
}

export function pickTier(sets: TierSets): ShareTier | null {
  if (sets.judged.length > 0) return "judged";
  if (sets.seen.length > 0) return "seen";
  return null;
}

export interface TrendBucket {
  since: Date;
  until: Date;
}

/**
 * Days for a window up to a month, weeks beyond it, counted back from the
 * window's end so the last bucket is always the most recent one.
 */
export function trendBuckets(window: { since: Date; until: Date }): TrendBucket[] {
  const span = window.until.getTime() - window.since.getTime();
  if (span <= 0) return [];
  const step = span <= 31 * DAY_MS ? DAY_MS : 7 * DAY_MS;
  const buckets: TrendBucket[] = [];
  for (let end = window.until.getTime(); end > window.since.getTime(); end -= step) {
    buckets.unshift({
      since: new Date(Math.max(end - step, window.since.getTime())),
      until: new Date(end),
    });
  }
  return buckets;
}

/**
 * What counts as a hit: the right tool ranked first (the headline), or found
 * anywhere in the list the search returned (Descriptions' score, the one a
 * rewrite moves).
 */
export type Measure = "first" | "found";

function hits(
  observations: readonly Pick<TierObservation, "rank">[],
  measure: Measure = "first",
): number {
  return observations.filter((observation) =>
    measure === "first" ? observation.rank === 1 : observation.rank !== null,
  ).length;
}

/** The share per bucket, oldest first: null where too few searches landed (a gap), a real 0 otherwise. */
export function shareTrend(
  observations: readonly TierObservation[],
  buckets: readonly TrendBucket[],
  minSample: number = MIN_BUCKET_SAMPLE,
  measure: Measure = "first",
): (number | null)[] {
  return buckets.map((bucket) => {
    const inside = observations.filter(
      (observation) =>
        observation.occurredAt >= bucket.since && observation.occurredAt < bucket.until,
    );
    return inside.length < minSample ? null : hits(inside, measure) / inside.length;
  });
}

export interface Headline {
  /** The one tier every figure is read from; null when neither has a search. */
  tier: ShareTier | null;
  /** Searches in that tier this window. */
  n: number;
  hits: number;
  /** Null below MIN_SHARE_SAMPLE searches. */
  share: number | null;
  /** Same tier, both windows at MIN_SHARE_SAMPLE or more, and the intervals apart. */
  change: Change | null;
  trend: (number | null)[];
  trendUnit: "day" | "week";
}

/**
 * The headline for a window against the window before it. `comparable` is
 * false when the read was cut short: a window missing its oldest searches
 * would invent a change. `measure` picks what a hit is (first place by
 * default), on the same tier and searches either way.
 */
export function buildHeadline(
  current: TierSets,
  previous: TierSets,
  window: { since: Date; until: Date },
  comparable = true,
  measure: Measure = "first",
): Headline {
  const buckets = trendBuckets(window);
  // The newest bucket is always a whole step; the oldest may be clipped by the window.
  const newest = buckets.at(-1);
  const trendUnit =
    newest && newest.until.getTime() - newest.since.getTime() > DAY_MS ? "week" : "day";
  const tier = pickTier(current);
  if (!tier) return { tier: null, n: 0, hits: 0, share: null, change: null, trend: [], trendUnit };

  const now = current[tier];
  const before = previous[tier];
  const found = hits(now, measure);
  const share = now.length >= MIN_SHARE_SAMPLE ? found / now.length : null;
  const beforeHits = hits(before, measure);
  const moved =
    comparable &&
    share !== null &&
    before.length >= MIN_SHARE_SAMPLE &&
    separated(wilsonInterval(found, now.length), wilsonInterval(beforeHits, before.length));
  return {
    tier,
    n: now.length,
    hits: found,
    share,
    change: moved ? pointChange(share, beforeHits / before.length) : null,
    trend: shareTrend(now, buckets, MIN_BUCKET_SAMPLE, measure),
    trendUnit,
  };
}

/**
 * The same tier read for another arm: one tier only, the one ours stands on,
 * so two numbers side by side are always measured the same way. Null when that
 * tier has nothing for this arm (a served list never counts on "Seen it run").
 */
export function onTier(sets: TierSets, tier: ShareTier | null): TierSets | null {
  if (tier === null || sets[tier].length === 0) return null;
  return tier === "judged" ? { judged: sets.judged, seen: [] } : { judged: [], seen: sets.seen };
}

/** Where the measured searches come from: the agent's own searches, or one variant of an experiment. */
export type EvidenceSourceLabel =
  | { kind: "telemetry" }
  | { kind: "experiment"; name: string; variant: string };

/** The value the headline shows: the share, or why there is none. */
export function headlineValue(headline: Pick<Headline, "tier" | "share">): string | null {
  if (headline.tier === null) return "Not measured yet";
  if (headline.share === null) return "Not enough searches yet";
  return null;
}

/** The line under the value: the tier and its population, or the next step. */
export function headlineNote(
  headline: Pick<Headline, "tier" | "n" | "share">,
  source: EvidenceSourceLabel,
  windowPhrase: string,
): string {
  if (headline.tier === null)
    return `No judged searches in ${windowPhrase}. Analyse searches to judge them.`;
  const label = TIER_LABEL[headline.tier];
  if (headline.share === null) {
    return `${label}: ${plural(headline.n, "search", "searches")} in ${windowPhrase}, ${MIN_SHARE_SAMPLE} needed`;
  }
  const where =
    source.kind === "telemetry"
      ? "your agent made"
      : `in ${source.name}, variant ${source.variant}`;
  return `${label} on ${plural(headline.n, "search", "searches")} ${where}`;
}
