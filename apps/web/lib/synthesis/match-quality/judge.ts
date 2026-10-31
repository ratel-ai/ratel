import { createHash } from "node:crypto";
import type { CorpusEntry } from "@/lib/readings/decisions/judge";
import { type GroundTruthLabel, queryKey } from "@/lib/synthesis/match-quality/labels";
import type { EvalItem } from "@/lib/synthesis/match-quality/types";

/**
 * The judge tier: asking a model which tool a search was actually asking for.
 *
 * WHY IT EXISTS. Without an invocation record the pipeline falls back to the
 * baseline's own first result, which is agreement with the incumbent rather than
 * proof of correctness. A loop tuned purely to agree with the incumbent converges
 * on it and stops, and on this data the incumbent's top-1 measured 79.5% against
 * ours at 61.8% in a blind evaluation, so "agree with it" is neither worthless
 * nor good enough to build on unexamined.
 *
 * WHERE IT RUNS. Only where there is nothing better. An item whose target came
 * from a real invocation is behaviour, and behaviour beats an opinion, so those
 * are never sent. The judge sees reference-tier items only.
 *
 * TWO STRATA, AND THIS IS THE WHOLE POINT. Sampling only the searches where the
 * two engines disagree finds things to fix but cannot measure anything: every
 * figure drawn from an all-disagreement sample is biased by construction. So a
 * second, smaller sample is drawn from the searches where the engines AGREE.
 * Together they give a stratified estimate of one number nobody currently has:
 *
 *     how often the baseline's first result was actually the right answer
 *
 * That is the worth of every unjudged reference item on the page, measured rather
 * than assumed, and it costs one extra model call per run.
 *
 * WHO JUDGES. A `JudgeEngine`, plugged in by `judges/index.ts`. This file owns
 * what gets judged and what a verdict does; an engine owns only how a verdict is
 * reached. Every engine must be able to answer with an entry neither search
 * engine returned, because "both engines missed it" is the most valuable verdict
 * there is, and must be able to abstain, because a two-word ambiguous query
 * should drop out rather than mint a coin-flip target that then nominates a tool
 * for rewriting. It is never told which engine returned what, nor what the
 * reference tier assumed.
 *
 * WHAT IT DOES NOT TOUCH. The quality meter's published numbers still come from
 * `observeSelections` over the revealed and reference tiers, unchanged, so a run
 * and the meter beside it stay comparable across time. The judge changes which
 * entries get NOMINATED, and reports how much the reference tier was worth.
 */

/**
 * Disagreements judged per run. These are the ones that change what gets fixed.
 *
 * Sized for a classifier-shaped engine, not a generative one. The first engine
 * was a Claude call over the whole sample at once, which priced judging at
 * about a cent a case and capped it at 32. Jev answers one case per call at a
 * few hundredths of a cent, so the cap is now a runaway guard rather than a
 * budget: in practice every distinct unjudged query in the window is read, and
 * the answer key (`labels.ts`) keeps the next run from paying for it again.
 */
export const MAX_DISPUTED_CASES = 2_000;

/**
 * Agreements judged per run. These are the ones that measure the reference tier.
 *
 * As high as the disputed cap for the same reason: once the whole control
 * stratum fits, `stratifiedAccuracy` stops being an estimate over a sample and
 * becomes a count over the population, less abstentions.
 */
export const MAX_CONTROL_CASES = 2_000;

/** Results per arm offered as context for one case. */
export const SHORTLIST_PER_ARM = 5;

/**
 * Fresh answers per stratum a window needs before judging slows down.
 *
 * About 500 answered searches put a stratum's accuracy within roughly +-4
 * points at 95%, which is as sharp as a weekly number needs to be. Until a
 * window holds that many, every unread request in the stratum is judged (budget
 * allowing); past it only a trickle of NEW requests is, so the key keeps
 * noticing new kinds of search without paying to re-measure a settled number.
 * This is how judging costs less and less as the key grows.
 */
export const TARGET_ANSWERS_PER_STRATUM = 500;

/** Share of never-read requests judged once a stratum has its target. */
export const TRICKLE_SHARE = 0.25;

/**
 * What one run may spend on judging, in dollars.
 *
 * The weekly sweep is where the answer key grows, so it gets the room: $1.50
 * reads ~3,000 requests over a 100-tool catalog, and in steady state a project
 * spends a few cents of it because judged requests are never paid for twice. A
 * manual run is someone pressing a button, possibly repeatedly, so it gets a
 * tenth of that: enough for the new requests since the last sweep, not enough
 * to rebuild a key by hand.
 */
export const JUDGE_BUDGET_USD = { scheduled: 1.5, manual: 0.15 } as const;

export type JudgeStratum = "disputed" | "control";

/** One search put to the judge. */
export interface JudgeCase {
  /** The eval item's selection id, so a verdict can be matched back. */
  id: string;
  query: string;
  /** Ids both engines returned, merged and shuffled. Never labelled by arm. */
  shortlist: string[];
  /** The baseline's first result. Never sent; used only for calibration. */
  assumed: string;
  stratum: JudgeStratum;
}

export interface JudgeVerdict {
  id: string;
  /** Empty when the judge declined to call it. */
  entryId: string;
  confident: boolean;
  /** The engine's confidence in [0, 1], when it has one. Stored on the label. */
  confidence?: number;
  /** The engine's second choice, when it has one: what this request is confused with. */
  runnerUp?: string;
}

/**
 * What the judging could see and what it found.
 *
 * `referenceAccuracy` is a STRATIFIED estimate: the two strata are sampled at
 * very different rates, so a raw hit rate over the judged set would be dominated
 * by whichever stratum happened to be sampled harder. Each stratum's agreement
 * rate is weighted by its share of the reference population instead.
 */
export interface JudgeCensus {
  model: string;
  mocked: boolean;
  /** Reference-tier items in each stratum, before sampling. */
  populationDisputed: number;
  populationControl: number;
  sampledDisputed: number;
  sampledControl: number;
  answeredDisputed: number;
  answeredControl: number;
  /** Verdicts that matched what the reference tier had assumed. */
  agreedDisputed: number;
  agreedControl: number;
  abstained: number;
  /** Items whose target the judge actually moved. */
  changed: number;
  /** Disagreements already driving a nomination, and how many of them we read. */
  nominatingPopulation: number;
  nominatingSampled: number;
  /** Stratified estimate of how often the baseline's top result was right. */
  referenceAccuracy: number | null;
}

/**
 * Anything that can decide which catalog entry a search was asking for.
 *
 * THIS IS THE PLUG. The pipeline knows only this shape, so swapping Jev for a
 * self-hosted model, or putting a generative model back, is a new file under
 * `judges/` and one line in its registry, not a change here.
 *
 * Contract, enforced by `validateVerdicts` whatever an engine returns:
 *   - one verdict per case id, and ids that were not asked about are dropped
 *   - an entry id the corpus does not hold is an abstention, never a target
 *   - an empty `entryId` is an abstention, and abstaining is always allowed
 *
 * An engine may leave cases out entirely, for instance when it hits its own
 * spending or time limit. A missing case stays on the reference tier, exactly
 * like an abstention. An engine that cannot judge at all should throw, so the
 * run logs one failure instead of silently reporting that nothing needed judging.
 */
export interface JudgeEngine {
  /** Stored on the run's census and on every label it writes. */
  model: string;
  judge(cases: readonly JudgeCase[], corpus: readonly CorpusEntry[]): Promise<JudgeVerdict[]>;
  /**
   * How many cases this engine can afford over this corpus in one run, from
   * its own budget and price. Absent means no limit beyond the per-stratum caps.
   */
  capacity?(corpus: readonly CorpusEntry[]): number;
}

/**
 * A fingerprint of what the tools ARE: ids, names, agent descriptions and the
 * searchable text the customer's SDK sent. Deliberately NOT Cloud overrides.
 *
 * A verdict is stored with the fingerprint it was made against. When the tools
 * change (one added, one removed, a description edited by the customer) older
 * verdicts go stale and are re-read as budget allows. Applying one of our own
 * rewrites does NOT change it, because the judge never reads our rewrites.
 */
export function identityFingerprint(corpus: readonly CorpusEntry[]): string {
  const rows = corpus
    .map((entry) =>
      [entry.entryId, entry.name, entry.description ?? "", entry.runtimeSearchable ?? ""].join(
        "\u0000",
      ),
    )
    .sort();
  return createHash("sha256").update(rows.join("\u0001")).digest("hex").slice(0, 32);
}

function normalise(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * A deterministic order that carries no arm signal.
 *
 * Shuffling by a hash of the case id and the entry id means the same case always
 * presents the same way, so a re-run is comparable and a snapshot test is
 * possible, while the order still has nothing to do with which engine returned
 * what or how highly. A plain sort by id would be deterministic too, but it
 * correlates with something real and unhelpful: alphabetically early entries
 * would lead every single case.
 */
function shuffleKey(caseId: string, entryId: string): number {
  let hash = 0x811c9dc5;
  for (const text of [caseId, " ", entryId]) {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return hash >>> 0;
}

/**
 * Pick the searches worth judging, in two strata.
 *
 * Deduplicated by query text first, so forty repetitions of one phrasing spend
 * one judgment rather than forty. Items arrive newest first, so the survivor of a
 * duplicate group is the most recent one.
 *
 * WHAT IS ELIGIBLE. A request with no answer yet (`unread`), and a request whose
 * stored verdict was made against tools that have since changed (`stale`). A
 * request with an observed invocation never is: behaviour beats an opinion.
 *
 * HOW MANY. Per stratum, everything unread until the window holds
 * {@link TARGET_ANSWERS_PER_STRATUM} fresh answers, then only a
 * {@link TRICKLE_SHARE} of the unread. Stale verdicts are re-read only with
 * what that leaves. The engine's own `capacity` caps the total.
 *
 * Within a stratum picks are strided across the window rather than the newest
 * N, because the newest N of a busy window can all be one afternoon of one
 * person's work, which is not a sample of anything.
 */
export function sampleForJudging(
  items: readonly EvalItem[],
  ourArm: string,
  baselineArm: string,
  opts: {
    maxDisputed?: number;
    maxControl?: number;
    /** Hard cap on the total, usually the engine's `capacity`. */
    maxCases?: number;
    /**
     * Selections already on course to nominate an entry for rewriting.
     *
     * These jump the disputed queue. A run that judges a random subset of the
     * disagreements and misses the ones actually driving proposals has spent
     * the call and kept the risk. Only the DISPUTED stratum is reordered: the
     * control stratum is the measurement, and prioritising inside it would bias
     * the very number it exists to produce.
     */
    priority?: ReadonlySet<string>;
    /** The stored answer key, keyed by `queryKey`. Absent means nothing is known. */
    key?: ReadonlyMap<string, GroundTruthLabel>;
    /** The current `identityFingerprint`; a verdict made against another is stale. */
    fingerprint?: string;
    targetPerStratum?: number;
    trickle?: number;
    /** The catalog's entry ids: a verdict naming a tool that is gone is stale. */
    corpusIds?: ReadonlySet<string>;
  } = {},
): {
  cases: JudgeCase[];
  populationDisputed: number;
  populationControl: number;
  nominatingPopulation: number;
  nominatingSampled: number;
} {
  const maxDisputed = opts.maxDisputed ?? MAX_DISPUTED_CASES;
  const maxControl = opts.maxControl ?? MAX_CONTROL_CASES;
  const target = opts.targetPerStratum ?? TARGET_ANSWERS_PER_STRATUM;
  const trickle = opts.trickle ?? TRICKLE_SHARE;
  const key = opts.key ?? new Map<string, GroundTruthLabel>();

  // A request the agent was seen running anywhere in the window is answered by
  // behaviour, so no other sighting of it is worth paying to judge.
  const seen = new Set<string>(
    items
      .filter((item) => item.targetSource === "invoked" && item.query?.trim())
      .map((item) => normalise(item.query ?? "")),
  );
  const pools = {
    disputed: { unread: [] as JudgeCase[], stale: [] as JudgeCase[], fresh: 0 },
    control: { unread: [] as JudgeCase[], stale: [] as JudgeCase[], fresh: 0 },
  };

  for (const item of items) {
    // Behaviour beats an opinion: an invoked target is never second-guessed.
    if (item.targetSource === "invoked") continue;
    const query = item.query?.trim();
    if (!query) continue;
    const normal = normalise(query);
    if (seen.has(normal)) continue;
    seen.add(normal);

    const ours = item.arms.find((arm) => arm.arm === ourArm);
    // No baseline (search telemetry, one engine): every search is one stratum,
    // "disputed", since there is no second engine to agree with.
    const baseline = item.arms.find((arm) => arm.arm === baselineArm);
    if (!ours) continue;

    const ourTop = ours.resultIds[0];
    const agreed =
      baseline !== undefined && ourTop !== undefined && ourTop === baseline.resultIds[0];
    const stratum: JudgeStratum = agreed ? "control" : "disputed";
    const pool = pools[stratum];

    const stored = key.get(queryKey(query) ?? normal);
    if (stored?.source === "invoked") continue;
    const namesGoneTool =
      stored !== undefined &&
      stored.entryId !== "" &&
      opts.corpusIds !== undefined &&
      !opts.corpusIds.has(stored.entryId);
    const isFresh =
      stored !== undefined &&
      !namesGoneTool &&
      opts.fingerprint !== undefined &&
      stored.catalogFingerprint === opts.fingerprint;
    if (isFresh) {
      // Only a decided answer counts toward the measurement target. A fresh
      // `unclear` is read (so never re-bought) but measures nothing.
      if (stored.source !== "unclear") pool.fresh += 1;
      continue;
    }

    const merged = new Set([
      ...ours.resultIds.slice(0, SHORTLIST_PER_ARM),
      ...(baseline?.resultIds.slice(0, SHORTLIST_PER_ARM) ?? []),
    ]);
    const shortlist = [...merged].sort(
      (left, right) => shuffleKey(item.selectionId, left) - shuffleKey(item.selectionId, right),
    );
    const entry: JudgeCase = {
      id: item.selectionId,
      query,
      shortlist,
      assumed: baseline?.resultIds[0] ?? item.targetEntryId,
      stratum,
    };
    (stored === undefined ? pool.unread : pool.stale).push(entry);
  }

  // Unread and stale are sized separately so stale verdicts are never starved:
  // below the target, unread first and stale with what is left; at or past it,
  // a trickle of EACH, so a catalog change is re-read over a few weekly runs
  // instead of never.
  const wanted = (pool: (typeof pools)["disputed"], max: number) => {
    const short = Math.max(0, target - pool.fresh);
    const unread = Math.min(
      pool.unread.length,
      Math.max(short, Math.ceil(trickle * pool.unread.length)),
    );
    const stale = Math.min(
      pool.stale.length,
      Math.max(short - unread, Math.ceil(trickle * pool.stale.length)),
    );
    const total = Math.min(max, unread + stale);
    return { unread: Math.min(unread, total), stale: Math.max(0, total - Math.min(unread, total)) };
  };
  const fill = (
    rows: readonly JudgeCase[],
    stale: readonly JudgeCase[],
    want: { unread: number; stale: number },
  ) => [...stride(rows, want.unread), ...stride(stale, want.stale)];

  const priority = opts.priority ?? new Set<string>();
  const disputedPool = [...pools.disputed.unread, ...pools.disputed.stale];
  const urgent = disputedPool.filter((row) => priority.has(row.id)).slice(0, maxDisputed);
  const urgentIds = new Set(urgent.map((row) => row.id));
  const disputedWant = wanted(pools.disputed, maxDisputed);
  const urgentUnread = urgent.filter((row) => pools.disputed.unread.includes(row)).length;
  const disputed = [
    ...urgent,
    ...fill(
      pools.disputed.unread.filter((row) => !urgentIds.has(row.id)),
      pools.disputed.stale.filter((row) => !urgentIds.has(row.id)),
      {
        unread: Math.max(0, disputedWant.unread - urgentUnread),
        stale: Math.max(0, disputedWant.stale - (urgent.length - urgentUnread)),
      },
    ),
  ];
  const control = fill(
    pools.control.unread,
    pools.control.stale,
    wanted(pools.control, maxControl),
  );

  // Urgent first, then the strata ALTERNATE, always: an engine that stops early
  // (its token budget or deadline) then still leaves both strata measured
  // instead of starving whichever was queued last.
  const maxCases = opts.maxCases ?? Number.POSITIVE_INFINITY;
  const rest = { disputed: disputed.slice(urgent.length), control: [...control] };
  const cases = urgent.slice(0, maxCases);
  while (cases.length < maxCases && (rest.disputed.length > 0 || rest.control.length > 0)) {
    const next = rest.disputed.shift();
    if (next) cases.push(next);
    if (cases.length >= maxCases) break;
    const other = rest.control.shift();
    if (other) cases.push(other);
  }

  const populationDisputed = pools.disputed.unread.length + pools.disputed.stale.length;
  const populationControl = pools.control.unread.length + pools.control.stale.length;
  return {
    cases,
    populationDisputed,
    populationControl,
    nominatingPopulation:
      disputedPool.filter((row) => priority.has(row.id)).length +
      [...pools.control.unread, ...pools.control.stale].filter((row) => priority.has(row.id))
        .length,
    nominatingSampled: cases.filter((row) => row.stratum === "disputed" && priority.has(row.id))
      .length,
  };
}

/** Evenly spaced picks, so a sample spans the window instead of clustering. */
function stride<T>(rows: readonly T[], limit: number): T[] {
  if (rows.length <= limit) return [...rows];
  const step = rows.length / limit;
  const picked: T[] = [];
  for (let index = 0; index < limit; index += 1) {
    const row = rows[Math.floor(index * step)];
    if (row !== undefined) picked.push(row);
  }
  return picked;
}

/**
 * Hold any engine's output to the contract `JudgeEngine` states.
 *
 * Applied to every engine rather than trusted to each one, because a wrong id
 * here does not fail loudly: it attributes a loss to an entry that does not
 * exist, or promotes an item nobody asked about.
 */
export function validateVerdicts(
  verdicts: readonly JudgeVerdict[],
  caseIds: ReadonlySet<string>,
  corpusIds: ReadonlySet<string>,
): JudgeVerdict[] {
  const seen = new Set<string>();
  const valid: JudgeVerdict[] = [];
  for (const verdict of verdicts) {
    const id = typeof verdict.id === "string" ? verdict.id.trim() : "";
    if (!caseIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    const claimed = typeof verdict.entryId === "string" ? verdict.entryId.trim() : "";
    // An id the catalog does not hold is an abstention, not a target. Coercing it
    // would attribute a loss to an entry that does not exist.
    const entryId = corpusIds.has(claimed) ? claimed : "";
    valid.push({
      id,
      entryId,
      confident: verdict.confident !== false,
      ...(typeof verdict.confidence === "number" ? { confidence: verdict.confidence } : {}),
      ...(typeof verdict.runnerUp === "string" && corpusIds.has(verdict.runnerUp)
        ? { runnerUp: verdict.runnerUp }
        : {}),
    });
  }
  return valid;
}

/**
 * Apply verdicts to the frozen items, and census what the judging was worth.
 *
 * A verdict applies to EVERY sighting of its request in the window, not just
 * the one that was asked about: the answer is a property of the request.
 *
 * An abstention leaves an unanswered item where it was, and turns an item whose
 * stale verdict was just re-read into "no answer" (reference), because the old
 * verdict was made against tools that no longer exist in that form. A verdict
 * that agrees with the baseline's pick still promotes the item: the target did
 * not move, but it has stopped being an assumption.
 */
export function applyVerdicts(
  items: readonly EvalItem[],
  cases: readonly JudgeCase[],
  verdicts: readonly JudgeVerdict[],
  population: {
    disputed: number;
    control: number;
    nominatingPopulation: number;
    nominatingSampled: number;
  },
  model: { model: string; mocked: boolean },
  baselineArm?: string,
): { items: EvalItem[]; census: JudgeCensus } {
  const caseById = new Map(cases.map((row) => [row.id, row]));
  const byId = new Map(verdicts.map((verdict) => [verdict.id, verdict]));
  const byQuery = new Map<string, JudgeVerdict>();
  for (const verdict of verdicts) {
    const source = caseById.get(verdict.id);
    if (source) byQuery.set(normalise(source.query), verdict);
  }

  let answeredDisputed = 0;
  let answeredControl = 0;
  let agreedDisputed = 0;
  let agreedControl = 0;
  let abstained = 0;
  let changed = 0;

  for (const verdict of verdicts) {
    const source = caseById.get(verdict.id);
    if (!source) continue;
    if (verdict.entryId === "") {
      abstained += 1;
      continue;
    }
    const agreed = verdict.entryId === source.assumed;
    if (source.stratum === "disputed") {
      answeredDisputed += 1;
      if (agreed) agreedDisputed += 1;
    } else {
      answeredControl += 1;
      if (agreed) agreedControl += 1;
    }
    if (!agreed) changed += 1;
  }

  const next = items.map((item) => {
    if (item.targetSource === "invoked") return item;
    const verdict =
      byId.get(item.selectionId) ?? (item.query ? byQuery.get(normalise(item.query)) : undefined);
    if (!verdict) return item;
    if (verdict.entryId !== "") {
      return { ...item, targetEntryId: verdict.entryId, targetSource: "judge" as const };
    }
    if (item.targetSource !== "judge") return item;
    return {
      ...item,
      targetEntryId: baselineTop(item, baselineArm) ?? item.targetEntryId,
      targetSource: "reference" as const,
    };
  });

  return {
    items: next,
    census: {
      model: model.model,
      mocked: model.mocked,
      populationDisputed: population.disputed,
      populationControl: population.control,
      nominatingPopulation: population.nominatingPopulation,
      nominatingSampled: population.nominatingSampled,
      sampledDisputed: cases.filter((row) => row.stratum === "disputed").length,
      sampledControl: cases.filter((row) => row.stratum === "control").length,
      answeredDisputed,
      answeredControl,
      agreedDisputed,
      agreedControl,
      abstained,
      changed,
      referenceAccuracy: stratifiedAccuracy(
        { answered: answeredDisputed, agreed: agreedDisputed, population: population.disputed },
        { answered: answeredControl, agreed: agreedControl, population: population.control },
      ),
    },
  };
}

function baselineTop(item: EvalItem, baselineArm: string | undefined): string | null {
  if (baselineArm === undefined) return null;
  return item.arms.find((arm) => arm.arm === baselineArm)?.resultIds[0] ?? null;
}

/**
 * The answer-key rows one judging pass bought, abstentions included.
 *
 * An abstention is stored as `unclear` so next week does not pay to be unsure
 * again. `observedAt` is the judging time, not the sighting's: a re-read of a
 * stale verdict must win the merge against the verdict it replaces.
 */
export function labelsFromVerdicts(
  cases: readonly JudgeCase[],
  verdicts: readonly JudgeVerdict[],
  meta: { model: string; fingerprint: string | null; judgedAt: Date },
): GroundTruthLabel[] {
  const caseById = new Map(cases.map((row) => [row.id, row]));
  const labels: GroundTruthLabel[] = [];
  for (const verdict of verdicts) {
    const source = caseById.get(verdict.id);
    const key = source ? queryKey(source.query) : null;
    if (!source || key === null) continue;
    labels.push({
      queryKey: key,
      query: source.query,
      entryId: verdict.entryId,
      source: verdict.entryId === "" ? "unclear" : "judge",
      confident: verdict.entryId !== "" && verdict.confident,
      model: meta.model,
      selectionId: source.id,
      occurrences: 1,
      observedAt: meta.judgedAt,
      confidence: verdict.confidence ?? null,
      runnerUp: verdict.runnerUp ?? null,
      catalogFingerprint: meta.fingerprint,
    });
  }
  return labels;
}

interface Stratum {
  answered: number;
  agreed: number;
  population: number;
}

/**
 * How often the baseline's first result was actually right, over the reference
 * population.
 *
 * Each stratum contributes its own agreement rate weighted by its share of the
 * population, not by how many of it we happened to judge. A stratum nobody
 * answered contributes nothing and its weight is dropped, so the estimate stays
 * over the part of the population that was actually measured rather than quietly
 * assuming the unmeasured half behaved like the measured one.
 */
export function stratifiedAccuracy(disputed: Stratum, control: Stratum): number | null {
  const strata = [disputed, control].filter((stratum) => stratum.answered > 0);
  const weight = strata.reduce((total, stratum) => total + stratum.population, 0);
  if (strata.length === 0 || weight === 0) return null;
  const sum = strata.reduce(
    (total, stratum) => total + (stratum.agreed / stratum.answered) * stratum.population,
    0,
  );
  return sum / weight;
}

/** Run the judge over one sample. Null when nothing was worth judging. */
export async function judgeTargets(
  items: readonly EvalItem[],
  corpus: readonly CorpusEntry[],
  ourArm: string,
  baselineArm: string,
  engine: JudgeEngine,
  opts: {
    mocked?: boolean;
    maxDisputed?: number;
    maxControl?: number;
    priority?: ReadonlySet<string>;
    key?: ReadonlyMap<string, GroundTruthLabel>;
    fingerprint?: string;
    judgedAt?: Date;
  } = {},
): Promise<{ items: EvalItem[]; census: JudgeCensus; labels: GroundTruthLabel[] } | null> {
  const capacity = engine.capacity?.(corpus);
  const { cases, populationDisputed, populationControl, nominatingPopulation, nominatingSampled } =
    sampleForJudging(items, ourArm, baselineArm, {
      ...opts,
      corpusIds: new Set(corpus.map((entry) => entry.entryId)),
      ...(capacity === undefined ? {} : { maxCases: Math.max(0, Math.floor(capacity)) }),
    });
  if (cases.length === 0) return null;

  const verdicts = validateVerdicts(
    await engine.judge(cases, corpus),
    new Set(cases.map((row) => row.id)),
    new Set(corpus.map((entry) => entry.entryId)),
  );
  const applied = applyVerdicts(
    items,
    cases,
    verdicts,
    {
      disputed: populationDisputed,
      control: populationControl,
      nominatingPopulation,
      nominatingSampled,
    },
    { model: engine.model, mocked: opts.mocked ?? false },
    baselineArm,
  );
  return {
    ...applied,
    labels: labelsFromVerdicts(cases, verdicts, {
      model: engine.model,
      fingerprint: opts.fingerprint ?? null,
      judgedAt: opts.judgedAt ?? new Date(),
    }),
  };
}
