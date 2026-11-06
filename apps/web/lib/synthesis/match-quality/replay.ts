import { ToolRegistry } from "@ratel-ai/sdk";
import type { ConfidenceInterval } from "@/lib/readings/stats";
import { rankOf } from "@/lib/synthesis/quality/ground-truth";
import {
  hitCredit,
  type QualityScore,
  type RankObservation,
  scoreTotals,
  totalsFromObservations,
} from "@/lib/synthesis/quality/metrics";
import { type CorpusEntry, indexableText, type TargetSource } from "./types";

/**
 * The backtest: re-running a whole labelled history against a changed corpus.
 *
 * WHAT THIS IS NOT. `preview.ts` is a spot-check. It takes ONE proposal, replays
 * only the searches that proposal's own entry was supposed to win, inside the one
 * window the run happened to read, and reports how many of them moved. That is
 * enough to say "this rewrite does something", and it is structurally incapable
 * of answering the question anyone actually has, which is:
 *
 *     if I apply these, does the catalog get BETTER?
 *
 * It cannot answer that for two reasons. It never scores the searches a rewrite
 * might BREAK, so a description that swallows a neighbour's vocabulary looks like
 * a pure win. And it reports counts rather than the metric the rest of the surface
 * is denominated in, so its answer cannot be compared to anything, including to
 * the quality meter printed above it.
 *
 * So this replays the ENTIRE labelled population — every search anywhere in the
 * project's accumulated history whose right answer is actually known — against the
 * corpus before and after, and scores both sides with `lib/quality/metrics.ts`,
 * the same containment-and-quality pair the meter publishes. The output is a
 * number that moved, in units a reader has already seen.
 *
 * FIDELITY, STATED ONCE AND HONESTLY. Ranking goes through `@ratel-ai/sdk`'s own
 * `ToolRegistry`, which is the native BM25 the SDK retrieves with, for the reason
 * `preview.ts` and `lib/playground/rank.ts` already give: a reimplementation would
 * quietly disagree with production. But production FUSES that BM25 with a dense
 * pass and then the client filters and truncates, so a BM25-only replay reproduces
 * the served top result roughly half the time. Two consequences, and both are
 * carried in the result rather than hidden:
 *
 *   - The ABSOLUTE before and after numbers are on this replay's own scale. They
 *     are not the meter's numbers and must never be printed as though they were.
 *   - The DELTA between them is a paired comparison on one engine, where that
 *     shared bias largely cancels. It is the trustworthy half of the output, and
 *     it is the half the headline is built from.
 *
 * Which is why the error bar here is a PAIRED BOOTSTRAP over per-search credit
 * deltas rather than `preview.ts`'s comparison against the absolute reproduction
 * rate. That test asks "is this movement larger than how often the scorer
 * disagrees with production", which is the right question for an absolute claim
 * and the wrong one for a paired one: it charges a difference-in-differences the
 * full error of each level, so a real and consistent gain reads as inconclusive.
 * The reproduction rate is still measured and still reported, as the fidelity
 * caveat it is.
 */

/** Pinned, not a knob. Matches `preview.ts` and `lib/playground/rank.ts`. */
const SEARCH_ORIGIN = "agent";

/**
 * How deep a lookup may go before the answer is "not in the list".
 *
 * A ceiling, not the scoring window. Each search is scored inside the window it
 * actually had — see {@link windowFor} — and this only bounds the search itself.
 */
export const REPLAY_TOP_K = 20;

/**
 * The window a search is scored in when it recorded no served list.
 *
 * Production does not have one top-K. Requests in this telemetry ask for 50, 5,
 * 3, 2 and 1, and served lists run from one result to ten. So a single global K
 * would be a number we invented; the served length is a number that happened.
 * This is only the fallback for a search that recorded nothing, and five is the
 * commonest served length in the data rather than a tuned constant.
 */
export const DEFAULT_REPLAY_WINDOW = 5;

/**
 * The window one search is judged in: the number of results the agent saw.
 *
 * WHY NOT A FIXED TOP-20. Because the question is not "is the tool findable" but
 * "did the agent get it", and an agent that was shown three results was never
 * going to act on the ninth. Scoring at 20 credits us for placements no one
 * could see, which is how the first version of this panel reported 94.6%
 * containment against a measured 72.1%: the same catalog, scored in a window
 * four times wider than production's.
 *
 * It is also what makes this number COMPARABLE TO THE ADMIN METER, which scores
 * the rank of the target inside the arm's recorded list and nothing wider. Same
 * question, same window, so the two surfaces can finally be read against each
 * other instead of quietly disagreeing.
 *
 * Both sides of a patch use the same window, so the comparison stays paired.
 */
export function windowFor(servedIds: readonly string[] | null): number {
  return servedIds && servedIds.length > 0 ? servedIds.length : DEFAULT_REPLAY_WINDOW;
}

/**
 * How many distinct searches one replay scores.
 *
 * The cost of a replay is (cases x corpus) BM25 queries run twice, in-process,
 * with no network and no model, so this ceiling is about keeping a run's duration
 * flat as a project's labelled history grows rather than about money. Two
 * thousand distinct phrasings is already far more than the judged population of
 * any project today, so in practice this binds on nothing and exists so that it
 * still binds on nothing in a year.
 */
export const MAX_REPLAY_CASES = 2_000;

/** Resamples drawn for the paired interval. Enough for a stable 95% percentile. */
const BOOTSTRAP_ITERATIONS = 1_000;

/** Worked movements carried into the stored result, for the UI to print. */
export const MAX_REPLAY_EXAMPLES = 12;

/** One labelled search, ready to replay. */
export interface ReplayCase {
  /** Normalized query text; the identity a label is stored against. */
  queryKey: string;
  query: string;
  targetEntryId: string;
  /** How the target was established. Carried so the mix can be reported. */
  source: TargetSource;
  /** Our arm's actually-served list, for the reproduction check. Null if absent. */
  servedIds: readonly string[] | null;
  /** The baseline arm's recorded list, scored as its own reference line. */
  baselineIds: readonly string[] | null;
  occurredAt: Date;
}

export interface ReplayPatch {
  entryId: string;
  searchableDescription: string;
}

/**
 * What happened to one search.
 *
 * The five kinds are the reader's own vocabulary for this: a tool we now find
 * that we did not before, one we have stopped finding, one that moved up, one
 * that moved down, and one that did not budge.
 */
export const MOVEMENT_KINDS = ["found", "lost", "promoted", "demoted", "unchanged"] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export interface Movement {
  query: string;
  targetEntryId: string;
  /** Our rank for the target before the patch, 1-based, or null when absent. */
  before: number | null;
  after: number | null;
  kind: MovementKind;
  /** Change in rank credit, in the same units Quality is measured in. */
  delta: number;
}

/** What the patch set did to the searches that were asking for one entry. */
export interface EntryEffect {
  entryId: string;
  /** Searches whose right answer was this entry. */
  n: number;
  /** Summed credit change over them. Negative is collateral damage. */
  delta: number;
  /**
   * Of those searches, how many had this entry in the list the agent saw,
   * before and after the patch set. The per-tool headline a proposal card
   * prints. Absent on results stored before it was recorded.
   */
  containedBefore?: number;
  containedAfter?: number;
  found: number;
  lost: number;
  promoted: number;
  demoted: number;
  /** True when this entry is one the patch set actually rewrote. */
  patched: boolean;
}

/**
 * What each engine really did, over searches whose answer neither engine set.
 *
 * `top1` is carried beside the rank-weighted scores because it is what a reader
 * means by "did we lead with the right tool": Quality credits rank 2 at 0.82
 * (see `metrics.ts:hitCredit`), so a 66% Quality is NOT "right first two thirds
 * of the time" and must never be read as one.
 */
export interface ServedComparison {
  n: number;
  ours: QualityScore;
  baseline: QualityScore;
  /** Share of searches where the engine's FIRST result was the right tool. */
  ourTop1: number;
  baselineTop1: number;
  /** Mean list length, which is what makes containment easy or hard to earn. */
  ourAverageReturned: number;
  baselineAverageReturned: number;
  /**
   * The same comparison split by whether the two engines led with the same tool.
   *
   * WHY THIS SPLIT IS THE ONE WORTH DRAWING. A single head-to-head says "we are
   * ten points behind" and gives a reader nothing to do about it. Split, the
   * same evidence says something far more useful and just as true: on the
   * searches where the two engines already agree we are IDENTICAL by
   * construction, and the entire gap lives in the minority where they differ.
   * That is the population every proposal on this page is drafted against, so
   * the split is not a softer framing of the number — it is the number pointed
   * at the thing that can be fixed.
   *
   * `share` is each stratum's share of the WHOLE replay population, not of this
   * sample, because the judge deliberately over-samples disagreements and a
   * reader who takes the sample's mix for the traffic's mix will overstate how
   * often this happens.
   */
  strata: {
    agreed: ServedStratum;
    disputed: ServedStratum;
  };
}

export interface ServedStratum {
  /** Searches of this kind that could be measured. */
  n: number;
  /** This stratum's share of the whole replay population, sampling aside. */
  share: number;
  ourContainment: number | null;
  baselineContainment: number | null;
  ourTop1: number | null;
  baselineTop1: number | null;
}

export interface ReplayDelta {
  /**
   * After minus before in CONTAINMENT: the share of searches whose right tool
   * appeared in the list at all.
   *
   * This is the headline, not `quality`, and the reason is what the list is for.
   * An agent reads every result it is given, so having the tool in the list is
   * the outcome and leading with it is a refinement — the same judgement
   * `metrics.ts:UnifiedObservation.reach` already makes, and the same one the
   * admin meter makes by printing Containment first.
   */
  containment: number;
  /** The same movement with credit for rank. Reported beside, never instead. */
  quality: number;
  /** 95% paired-bootstrap interval on the Quality change. */
  interval: ConfidenceInterval;
  /** True when that interval excludes zero. */
  significant: boolean;
}

/**
 * Which per-search credit a stored result was scored with.
 *
 * Stored on every result so a blob written under an older curve can be found and
 * re-scored (see `rescore.ts`) instead of sitting beside fresh ones on a
 * different scale. Bump it whenever `metrics.ts:hitCredit` changes shape, or
 * when the stored result gains a field the page reads, so the re-score script
 * picks the old ones up. A blob with no value predates the field and was scored
 * with plain nDCG.
 *
 * `shown-half.2` added per-entry in-list counts (`EntryEffect.containedBefore`).
 */
export const REPLAY_CREDIT = "shown-half.2";

export interface ReplayResult {
  scorer: "bm25-replay";
  /** See {@link REPLAY_CREDIT}. */
  credit: typeof REPLAY_CREDIT;
  /** Distinct searches replayed. */
  n: number;
  before: QualityScore;
  after: QualityScore;
  delta: ReplayDelta;
  movements: Record<MovementKind, number>;
  /** The most consequential movements, biggest absolute change first. */
  examples: Movement[];
  /** Per-entry effect, biggest absolute change first. */
  byEntry: EntryEffect[];
  /**
   * The incumbent, from the lists it actually returned rather than from a replay.
   *
   * Scored ONLY over searches whose answer was established independently of it —
   * an invocation or a judge's verdict — never over `reference` cases, where the
   * target is its own first result and the comparison is an identity. See the
   * circularity guard in {@link replay}.
   *
   * No replay enters this figure, so it carries no scorer error; but it is
   * measured over a different, smaller population than `before` and `after`, and
   * {@link baselineN} is how many. A surface that prints it beside them without
   * that number is inviting a comparison the evidence does not support.
   */
  baseline: QualityScore | null;
  /** Searches the baseline line was drawn over. Zero when it is null. */
  baselineN: number;
  /**
   * OUR arm over that same independently-answered subset, from the list
   * production actually served.
   *
   * The one honest head-to-head available. `before`/`after` are a replay over
   * the whole population; `baseline` is real telemetry over a small subset. Put
   * side by side they invite a comparison that is wrong twice over — different
   * scorer AND different population — and that is exactly the reading the first
   * version of this panel produced ("we cover 94.6%, they cover 76%", which
   * compared a replayed number against a measured one).
   *
   * So this is measured the same way the baseline is, over the same searches:
   * no replay, no scorer error, same denominator. Null when nothing could be
   * measured that way.
   */
  served: ServedComparison | null;
  /** Share of searches whose served top result the unpatched replay reproduces. */
  reproductionRate: number | null;
  reproductionSample: number;
  /** The evidence mix of the replayed population. */
  evidence: { invoked: number; judged: number; assumed: number };
  /** Mean size of the window each search was scored in. */
  averageWindow: number;
  /** Cases dropped because their target is no longer in the corpus. */
  droppedUnknownTarget: number;
  /**
   * Drafts the pipeline threw away because this replay measured them worse.
   *
   * Set by the caller, not by `replay` itself, which knows nothing about
   * proposals. It lives here because the panel that prints it is already reading
   * this blob, and the discarded rewrites are deliberately not stored anywhere
   * else — only their number survives.
   */
  discarded?: number;
  truncated: boolean;
}

/** One measured search: where each engine put the right answer. */
interface MeasuredPair {
  ourRank: number | null;
  theirRank: number | null;
}

/** Whether the two engines led with different tools on this search. */
function disputedCase(row: ReplayCase): boolean {
  return (row.servedIds?.[0] ?? null) !== (row.baselineIds?.[0] ?? null);
}

function stratumOf(rows: readonly MeasuredPair[], share: number): ServedStratum {
  if (rows.length === 0) {
    return {
      n: 0,
      share,
      ourContainment: null,
      baselineContainment: null,
      ourTop1: null,
      baselineTop1: null,
    };
  }
  const rate = (predicate: (row: MeasuredPair) => boolean) =>
    rows.filter(predicate).length / rows.length;
  return {
    n: rows.length,
    share,
    ourContainment: rate((row) => row.ourRank !== null),
    baselineContainment: rate((row) => row.theirRank !== null),
    ourTop1: rate((row) => row.ourRank === 1),
    baselineTop1: rate((row) => row.theirRank === 1),
  };
}

/* — building the two registries --------------------------------------------- */

/**
 * Entries the BM25 index can actually hold.
 *
 * An entry whose searchable text is empty is SKIPPED, not registered with a
 * placeholder. The native registry rejects a missing description outright
 * (`Missing field 'description'`), and a runtime catalog really does carry such
 * rows — a tool synced with no description at all, which the demo catalog has two
 * of. Registering it with a space or its own name instead would be worse than
 * skipping: it would invent index terms nothing in production matches on, and the
 * replay would then score a ranking no agent could ever see.
 *
 * Skipping costs nothing that was not already lost. BM25 cannot return a document
 * with no terms, so an entry with no text is unreachable in production too; the
 * only difference here is that the run survives to say so.
 */
function indexable(entry: CorpusEntry, text: string): boolean {
  return indexableText(text).length > 0 && indexableText(entry.name).length > 0;
}

export function registerAll(
  entries: readonly CorpusEntry[],
  patches: ReadonlyMap<string, string>,
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const entry of entries) {
    const searchable = patches.get(entry.entryId) ?? entry.searchable;
    if (!indexable(entry, searchable)) continue;
    // `register` is declared async but indexes in-process, exactly as the
    // Playground and the spot-check call it. Awaiting per entry would serialize
    // a hundred no-op microtasks for nothing.
    void registry.register({
      id: entry.entryId,
      name: entry.name,
      description: searchable,
      // Observed entries carry no synced schema; an open object keeps the shape
      // valid without asserting parameters we do not actually know.
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    });
  }
  return registry;
}

/**
 * The same BM25 order the replay scores with, for a caller that has to narrow a
 * corpus before handing it on: the judge, when a catalog outgrows what one Jev
 * question can carry. Built once, queried per search.
 */
export function bm25Order(
  entries: readonly CorpusEntry[],
): (query: string, depth: number) => string[] {
  const registry = registerAll(entries, new Map());
  return (query, depth) =>
    registry.searchWithOrigin(query, depth, SEARCH_ORIGIN).map((hit) => hit.toolId);
}

export function rankIn(
  registry: ToolRegistry,
  query: string,
  targetId: string,
  window: number,
): number | null {
  const depth = Math.min(Math.max(window, 1), REPLAY_TOP_K);
  const hits = registry.searchWithOrigin(query, depth, SEARCH_ORIGIN);
  const index = hits.findIndex((hit) => hit.toolId === targetId);
  return index === -1 ? null : index + 1;
}

function topIn(registry: ToolRegistry, query: string): string | null {
  return registry.searchWithOrigin(query, 1, SEARCH_ORIGIN)[0]?.toolId ?? null;
}

/* — the pure pieces, exported so they can be asserted on their own ----------- */

/** Which of the five things happened to one search. */
export function classifyMovement(before: number | null, after: number | null): MovementKind {
  if (before === null && after === null) return "unchanged";
  if (before === null) return "found";
  if (after === null) return "lost";
  if (after < before) return "promoted";
  if (after > before) return "demoted";
  return "unchanged";
}

/**
 * Thin an oversized population by taking an even stride across it.
 *
 * NOT the newest N. A project's labelled history spans every window it has ever
 * run, and taking the head of it would quietly scope a replay that claims to
 * cover the whole history to whichever weeks happened to sort first. Same shape,
 * and the same reason, as `evidence.ts:spreadAcross` and the judge's control
 * stratum.
 */
export function thinCases<T>(rows: readonly T[], limit: number): T[] {
  if (rows.length <= limit) return [...rows];
  const step = rows.length / limit;
  const picked: T[] = [];
  for (let index = 0; index < limit; index += 1) {
    const row = rows[Math.floor(index * step)];
    if (row !== undefined) picked.push(row);
  }
  return picked;
}

/** A small, fast, seedable PRNG. Deterministic across processes and platforms. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A 95% percentile interval on the MEAN of `deltas`, by paired bootstrap.
 *
 * Paired because every delta is one search measured twice on the same engine, so
 * the engine's own bias against production is common to both measurements and
 * subtracts out. What is left to estimate is how much the mean would move if we
 * had drawn a different set of searches, which is exactly what resampling the
 * searches with replacement answers.
 *
 * Seeded, so a stored interval can be recomputed and a test can assert on it. An
 * unseeded bootstrap would make the same run produce two different published
 * numbers, which is the one thing a confidence interval must never do.
 */
export function bootstrapInterval(
  deltas: readonly number[],
  seed: string,
  iterations: number = BOOTSTRAP_ITERATIONS,
): ConfidenceInterval {
  if (deltas.length === 0) return { low: 0, high: 0 };
  const random = mulberry32(hashSeed(seed));
  const means: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0;
    for (let draw = 0; draw < deltas.length; draw += 1) {
      sum += deltas[Math.floor(random() * deltas.length)]!;
    }
    means.push(sum / deltas.length);
  }
  means.sort((left, right) => left - right);
  return {
    low: means[Math.floor(iterations * 0.025)]!,
    high: means[Math.min(iterations - 1, Math.floor(iterations * 0.975))]!,
  };
}

/* — the replay --------------------------------------------------------------- */

/**
 * Replay one labelled history against a patched corpus.
 *
 * Pure: it reads the corpus, the cases and the patches and nothing else, so the
 * same inputs always produce the same published numbers and a stored result can
 * be reproduced from the frozen rows that fed it.
 */
export function replay(
  corpus: readonly CorpusEntry[],
  cases: readonly ReplayCase[],
  patches: readonly ReplayPatch[],
  opts: { cap?: number } = {},
): ReplayResult {
  const cap = opts.cap ?? MAX_REPLAY_CASES;
  const known = new Set(corpus.map((entry) => entry.entryId));

  // A search whose right answer has left the catalog measures nothing: it would
  // score zero on both sides and drag both numbers down by however many tools
  // have been retired since. Dropped and counted, never scored as a miss.
  const scorable: ReplayCase[] = [];
  const seen = new Set<string>();
  let droppedUnknownTarget = 0;
  for (const row of cases) {
    if (!known.has(row.targetEntryId)) {
      droppedUnknownTarget += 1;
      continue;
    }
    if (seen.has(row.queryKey)) continue;
    seen.add(row.queryKey);
    scorable.push(row);
  }

  const truncated = scorable.length > cap;
  const population = thinCases(scorable, cap);

  const patchMap = new Map(patches.map((patch) => [patch.entryId, patch.searchableDescription]));
  const before = registerAll(corpus, new Map());
  // Rebuilding is skipped when nothing is patched: the two registries would be
  // identical, and indexing a catalog twice to prove a delta of zero is waste.
  const after = patchMap.size === 0 ? before : registerAll(corpus, patchMap);

  const beforeObservations: RankObservation[] = [];
  const afterObservations: RankObservation[] = [];
  const baselineObservations: RankObservation[] = [];
  const servedObservations: RankObservation[] = [];
  let ourTop1 = 0;
  let baselineTop1 = 0;
  let ourReturned = 0;
  let baselineReturned = 0;
  const measuredAgreed: MeasuredPair[] = [];
  const measuredDisputed: MeasuredPair[] = [];
  // Two paired series. The interval is drawn over the CONTAINMENT one, because
  // an error bar must measure the number it is printed beside, and the headline
  // is containment. Each entry is -1, 0 or +1: lost from the list, unmoved, or
  // newly in it.
  const containmentDeltas: number[] = [];
  const deltas: number[] = [];
  const movements: Movement[] = [];
  const effects = new Map<string, EntryEffect>();
  const tally: Record<MovementKind, number> = {
    found: 0,
    lost: 0,
    promoted: 0,
    demoted: 0,
    unchanged: 0,
  };
  const evidence = { invoked: 0, judged: 0, assumed: 0 };

  let reproduced = 0;
  let reproductionSample = 0;
  let windowSum = 0;
  // Every case, not just the measurable ones: the strata shares describe the
  // traffic, and the judge's sampling must not be mistaken for the traffic's mix.
  let populationDisputed = 0;
  let baselineSeen = false;

  for (const row of population) {
    const window = windowFor(row.servedIds);
    windowSum += window;
    const beforeRank = rankIn(before, row.query, row.targetEntryId, window);
    const afterRank =
      patchMap.size === 0 ? beforeRank : rankIn(after, row.query, row.targetEntryId, window);

    beforeObservations.push({ rank: beforeRank });
    afterObservations.push({ rank: afterRank });

    const beforeCredit = hitCredit(beforeRank);
    const afterCredit = hitCredit(afterRank);
    const delta = afterCredit - beforeCredit;
    deltas.push(delta);
    containmentDeltas.push((afterRank === null ? 0 : 1) - (beforeRank === null ? 0 : 1));

    const kind = classifyMovement(beforeRank, afterRank);
    tally[kind] += 1;
    if (kind !== "unchanged") {
      movements.push({
        query: row.query,
        targetEntryId: row.targetEntryId,
        before: beforeRank,
        after: afterRank,
        kind,
        delta,
      });
    }

    const effect = effects.get(row.targetEntryId) ?? {
      entryId: row.targetEntryId,
      n: 0,
      delta: 0,
      containedBefore: 0,
      containedAfter: 0,
      found: 0,
      lost: 0,
      promoted: 0,
      demoted: 0,
      patched: patchMap.has(row.targetEntryId),
    };
    effect.n += 1;
    effect.delta += delta;
    if (beforeRank !== null) effect.containedBefore = (effect.containedBefore ?? 0) + 1;
    if (afterRank !== null) effect.containedAfter = (effect.containedAfter ?? 0) + 1;
    if (kind !== "unchanged") effect[kind] += 1;
    effects.set(row.targetEntryId, effect);

    if (row.source === "invoked") evidence.invoked += 1;
    else if (row.source === "judge") evidence.judged += 1;
    else evidence.assumed += 1;

    if (disputedCase(row)) populationDisputed += 1;

    if (row.servedIds && row.servedIds.length > 0) {
      reproductionSample += 1;
      if (topIn(before, row.query) === row.servedIds[0]) reproduced += 1;
    }

    // THE CIRCULARITY GUARD. On a `reference` case the target IS the baseline's
    // own first result, by construction, so scoring the baseline there asks
    // whether it agrees with itself and the answer is always yes. Measured on
    // production: over 389 searches of which 355 were reference-tier, the
    // baseline scored 98% against our 66%, which reads as a rout and is very
    // nearly an identity. Those cases are excluded, so this line is only ever
    // drawn over searches whose answer was established INDEPENDENTLY of it.
    if (row.source !== "reference" && row.baselineIds && row.baselineIds.length > 0) {
      baselineSeen = true;
      baselineObservations.push({ rank: rankOf(row.baselineIds, row.targetEntryId) });
      // Our arm over the SAME searches, measured the same way, so the two lines
      // can honestly be read against each other.
      const servedIds = row.servedIds ?? [];
      const ourRank = rankOf(servedIds, row.targetEntryId);
      const theirRank = rankOf(row.baselineIds, row.targetEntryId);
      servedObservations.push({ rank: ourRank });
      if (ourRank === 1) ourTop1 += 1;
      if (row.baselineIds[0] === row.targetEntryId) baselineTop1 += 1;
      ourReturned += servedIds.length;
      baselineReturned += row.baselineIds.length;
      (disputedCase(row) ? measuredDisputed : measuredAgreed).push({
        ourRank,
        theirRank,
      });
    }
  }

  const beforeScore = scoreTotals(totalsFromObservations(beforeObservations));
  const afterScore = scoreTotals(totalsFromObservations(afterObservations));
  // Seeded from the population itself, so the interval is a property of the
  // evidence rather than of when the run happened to execute.
  const interval = bootstrapInterval(
    containmentDeltas,
    population.map((row) => row.queryKey).join("|"),
  );

  return {
    scorer: "bm25-replay",
    credit: REPLAY_CREDIT,
    n: population.length,
    before: beforeScore,
    after: afterScore,
    delta: {
      containment: (afterScore.containment ?? 0) - (beforeScore.containment ?? 0),
      quality: (afterScore.quality ?? 0) - (beforeScore.quality ?? 0),
      interval,
      // Excluding zero in either direction. A regression this confident is just
      // as much a result as a gain, and reporting only one of them would make
      // the surface an advocate rather than a measurement.
      significant: interval.low > 0 || interval.high < 0,
    },
    movements: tally,
    examples: [...movements]
      .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
      .slice(0, MAX_REPLAY_EXAMPLES),
    // A patched entry is always kept, even unmoved: its card reads its own
    // in-list counts from here, and "no change" is an answer worth printing.
    byEntry: [...effects.values()]
      .filter((effect) => effect.delta !== 0 || effect.patched)
      .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta)),
    baseline: baselineSeen ? scoreTotals(totalsFromObservations(baselineObservations)) : null,
    baselineN: baselineObservations.length,
    served:
      baselineObservations.length === 0
        ? null
        : {
            n: baselineObservations.length,
            ours: scoreTotals(totalsFromObservations(servedObservations)),
            baseline: scoreTotals(totalsFromObservations(baselineObservations)),
            ourTop1: ourTop1 / baselineObservations.length,
            baselineTop1: baselineTop1 / baselineObservations.length,
            ourAverageReturned: ourReturned / baselineObservations.length,
            baselineAverageReturned: baselineReturned / baselineObservations.length,
            strata: {
              agreed: stratumOf(
                measuredAgreed,
                population.length === 0
                  ? 0
                  : (population.length - populationDisputed) / population.length,
              ),
              disputed: stratumOf(
                measuredDisputed,
                population.length === 0 ? 0 : populationDisputed / population.length,
              ),
            },
          },
    averageWindow: population.length === 0 ? 0 : windowSum / population.length,
    reproductionRate: reproductionSample === 0 ? null : reproduced / reproductionSample,
    reproductionSample,
    evidence,
    droppedUnknownTarget,
    truncated,
  };
}
