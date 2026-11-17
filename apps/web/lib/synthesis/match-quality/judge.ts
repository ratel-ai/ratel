import { createHash } from "node:crypto";
import type { CorpusEntry } from "@/lib/readings/decisions/judge";
import {
  AUDIT_SAMPLE,
  auditVerdict,
  DEFAULT_TARGET_MARGIN,
  labelsNeeded,
  type StratumTally,
  spreadPick,
  stratifiedShare,
} from "@/lib/readings/labelling/adaptive";
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

/** Results per arm offered as context for one case. */
export const SHORTLIST_PER_ARM = 5;

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
  /** How the adaptive loop went (RC-394); absent on a census stored before it. */
  adaptive?: AdaptiveCensus;
}

/** What the adaptive loop did in one run, stored on the census. */
export interface AdaptiveCensus {
  rounds: number;
  targetMargin: number;
  /** Our first result was the right tool, over the window's distinct answered requests, weighted by stratum. */
  share: number | null;
  /** Its 95% margin after this run's answers. */
  margin: number | null;
  /** Requests still unanswered that the margin would want; zero when it was met. */
  stillNeeded: number;
  /** Carried verdicts re-asked, how many came back the same, and what that said. */
  audited: number;
  auditAgreed: number;
  audit: "trust" | "distrust" | "unknown";
  /** Why the loop stopped. */
  stopped:
    | "margin_met"
    | "nothing_left"
    | "capacity"
    | "engine_stopped"
    | "engine_failed"
    | "deadline"
    | "max_rounds";
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
 * The parts of a tool a verdict about it depends on, hashed: what
 * `identityFingerprint` reads, for one entry.
 */
function entryIdentity(entry: CorpusEntry | undefined): string {
  if (!entry) return "";
  return [entry.entryId, entry.name, entry.description ?? "", entry.runtimeSearchable ?? ""].join(
    "\u0000",
  );
}

/** Every entry's identity, for `labelPrint` and `readPrint`. */
export function entryIdentities(corpus: readonly CorpusEntry[]): Map<string, string> {
  return new Map(corpus.map((entry) => [entry.entryId, entryIdentity(entry)]));
}

const ENTRY_PRINT = "e:";

function entryPart(
  identities: ReadonlyMap<string, string>,
  entryId: string,
  runnerUp: string | null | undefined,
): string {
  const rows = [
    identities.get(entryId) ?? `missing:${entryId}`,
    runnerUp ? (identities.get(runnerUp) ?? `missing:${runnerUp}`) : "",
  ];
  return createHash("sha256").update(rows.join("\u0001")).digest("hex").slice(0, 24);
}

/**
 * The fingerprint a verdict is stored with (RC-394).
 *
 * A decided verdict is about the tool it chose and the one it nearly chose,
 * so it is printed with those two: `e:<their identity>:<the catalog's>`. It
 * stays fresh while they are unchanged, however many other tools come and go;
 * a catalog that moved only marks it for the audit, which re-asks a sample.
 * An abstention is about the whole catalog (any new tool might answer it), so
 * it keeps the catalog fingerprint alone, as every verdict did before.
 */
export function labelPrint(
  identities: ReadonlyMap<string, string>,
  catalog: string,
  entryId: string,
  runnerUp?: string | null,
): string {
  if (entryId === "") return catalog;
  return `${ENTRY_PRINT}${entryPart(identities, entryId, runnerUp)}:${catalog}`;
}

/**
 * How a stored verdict stands against today's tools: `fresh` while what it
 * was made against is unchanged, and `moved` when it is fresh but the rest of
 * the catalog changed since (the audit's pool). A catalog-wide print (every
 * verdict before RC-394, and every abstention) is fresh only on the same
 * catalog, exactly as before.
 */
export function readPrint(
  stored: Pick<GroundTruthLabel, "entryId" | "runnerUp" | "catalogFingerprint">,
  identities: ReadonlyMap<string, string> | undefined,
  catalog: string | undefined,
): { fresh: boolean; moved: boolean } {
  const print = stored.catalogFingerprint ?? null;
  if (print === null || catalog === undefined) return { fresh: false, moved: false };
  if (!print.startsWith(ENTRY_PRINT) || identities === undefined)
    return { fresh: print === catalog, moved: false };
  const [entry, made] = print.slice(ENTRY_PRINT.length).split(":");
  if (stored.entryId === "" || entry !== entryPart(identities, stored.entryId, stored.runnerUp))
    return { fresh: false, moved: false };
  return { fresh: true, moved: made !== catalog };
}

interface StratumPool {
  unread: JudgeCase[];
  stale: JudgeCase[];
  /** Fresh decided verdicts whose catalog moved since: re-asked by the audit. */
  moved: JudgeCase[];
  /** Fresh decided verdicts in the window. */
  fresh: number;
  /** Of those, how many named our engine's first result. */
  freshHits: number;
}

interface Pools {
  disputed: StratumPool;
  control: StratumPool;
}

interface PoolOptions {
  key?: ReadonlyMap<string, GroundTruthLabel>;
  fingerprint?: string;
  corpusIds?: ReadonlySet<string>;
  identities?: ReadonlyMap<string, string>;
  /** A failed audit: a fresh verdict whose catalog moved counts as stale. */
  distrustMoved?: boolean;
}

/**
 * Sort the window's distinct requests into the two strata, and within each
 * into unread, stale and fresh (see `sampleAdaptively`). Deduplicated by
 * query text, newest sighting kept; a request the agent was seen running is
 * never eligible: behaviour beats an opinion.
 */
function buildPools(
  items: readonly EvalItem[],
  ourArm: string,
  baselineArm: string,
  opts: PoolOptions,
): Pools {
  const key = opts.key ?? new Map<string, GroundTruthLabel>();
  const seen = new Set<string>(
    items
      .filter((item) => item.targetSource === "invoked" && item.query?.trim())
      .map((item) => normalise(item.query ?? "")),
  );
  const empty = (): StratumPool => ({ unread: [], stale: [], moved: [], fresh: 0, freshHits: 0 });
  const pools: Pools = { disputed: empty(), control: empty() };

  for (const item of items) {
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
    const print =
      stored === undefined || namesGoneTool
        ? { fresh: false, moved: false }
        : readPrint(stored, opts.identities, opts.fingerprint);

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

    if (stored !== undefined && print.fresh && !(print.moved && opts.distrustMoved)) {
      // Only a decided answer counts toward the measurement. A fresh
      // `unclear` is read (so never re-bought) but measures nothing.
      if (stored.source !== "unclear") {
        pool.fresh += 1;
        if (stored.entryId === ourTop) pool.freshHits += 1;
        if (print.moved) pool.moved.push(entry);
      }
      continue;
    }
    (stored === undefined ? pool.unread : pool.stale).push(entry);
  }
  return pools;
}

/** What a sample is drawn from, and what it measured so far: for the census and the adaptive loop. */
interface SampleResult {
  cases: JudgeCase[];
  populationDisputed: number;
  populationControl: number;
  nominatingPopulation: number;
  nominatingSampled: number;
}

function nominating(pools: Pools, cases: readonly JudgeCase[], priority: ReadonlySet<string>) {
  const all = [
    ...pools.disputed.unread,
    ...pools.disputed.stale,
    ...pools.control.unread,
    ...pools.control.stale,
  ];
  return {
    nominatingPopulation: all.filter((row) => priority.has(row.id)).length,
    nominatingSampled: cases.filter((row) => row.stratum === "disputed" && priority.has(row.id))
      .length,
  };
}

/** Urgent first, then the strata alternate, so an engine that stops early still leaves both measured. */
function interleave(
  urgent: readonly JudgeCase[],
  disputed: readonly JudgeCase[],
  control: readonly JudgeCase[],
  maxCases: number,
): JudgeCase[] {
  const rest = { disputed: [...disputed], control: [...control] };
  const cases = urgent.slice(0, maxCases);
  while (cases.length < maxCases && (rest.disputed.length > 0 || rest.control.length > 0)) {
    const next = rest.disputed.shift();
    if (next) cases.push(next);
    if (cases.length >= maxCases) break;
    const other = rest.control.shift();
    if (other) cases.push(other);
  }
  return cases;
}

/** Requests one adaptive round asks about at most: the batch Kayra's loop looks at before asking for more. */
export const ADAPTIVE_ROUND_SIZE = 100;
/** Rounds one run may take; with the round size, a ceiling of 600 answers per run. */
export const ADAPTIVE_MAX_ROUNDS = 6;
/** Never-read requests asked per stratum per run once the margin is met, so the key notices new kinds of search. */
export const DRIFT_PER_STRATUM = 10;

/** How far one adaptive round got, for the census. */
export interface AdaptiveTally {
  disputed: StratumTally;
  control: StratumTally;
}

/**
 * The adaptive sample (RC-394): as many requests as the headline share
 * still needs for its margin, plus a small drift sample.
 *
 * Deduplicated by query text, so forty repetitions of one phrasing spend one
 * judgment. A request with no answer yet (unread) and one whose stored
 * verdict was made against tools that have since changed (stale) are both
 * eligible; a request with an observed invocation never is.
 *
 * The share is "our first result was the right tool" over each stratum's
 * distinct requests; `labelsNeeded` sizes each stratum by Neyman allocation
 * from the fresh answers it already holds. Unread and stale requests are one
 * pool (both are unanswered today), picked evenly over the window. Requests
 * driving a proposal still jump the disputed queue. Up to `audit` fresh
 * verdicts whose catalog moved since are re-asked to check that carrying them
 * is safe; `distrustMoved` (a failed audit) counts all of those as stale.
 * One call is one round; `judgeTargets` loops, re-estimating between rounds.
 */
export function sampleAdaptively(
  items: readonly EvalItem[],
  ourArm: string,
  baselineArm: string,
  opts: PoolOptions & {
    maxCases?: number;
    priority?: ReadonlySet<string>;
    targetMargin?: number;
    drift?: number;
    audit?: number;
  } = {},
): SampleResult & { tally: AdaptiveTally; audit: JudgeCase[] } {
  const pools = buildPools(items, ourArm, baselineArm, opts);
  const tallyOf = (pool: StratumPool): StratumTally => ({
    population: pool.unread.length + pool.stale.length + pool.fresh,
    labelled: pool.fresh,
    hits: pool.freshHits,
  });
  const tally = { disputed: tallyOf(pools.disputed), control: tallyOf(pools.control) };
  const [needDisputed = 0, needControl = 0] = labelsNeeded(
    [tally.disputed, tally.control],
    opts.targetMargin ?? DEFAULT_TARGET_MARGIN,
  );
  const drift = opts.drift ?? DRIFT_PER_STRATUM;
  const priority = opts.priority ?? new Set<string>();

  // A round asks at most `maxCases`, so each stratum's pick is capped at that
  // BEFORE spreading: picking the full need and truncating later would keep
  // the newest slice of the window.
  const roundCap = opts.maxCases ?? Number.POSITIVE_INFINITY;
  const pick = (pool: StratumPool, need: number, skip: ReadonlySet<string>) => {
    const open = [...pool.unread, ...pool.stale].filter((row) => !skip.has(row.id));
    const chosen = spreadPick(open, Math.min(need, roundCap));
    if (need > 0 || drift <= 0) return chosen;
    // Margin met: a few never-read requests only, so new kinds of search still get noticed.
    return spreadPick(
      pool.unread.filter((row) => !skip.has(row.id)),
      Math.min(drift, roundCap),
    );
  };
  const urgentAll = [...pools.disputed.unread, ...pools.disputed.stale].filter((row) =>
    priority.has(row.id),
  );
  // Every request driving a proposal is read: what gets fixed depends on it.
  const urgent = urgentAll;
  const urgentIds = new Set(urgent.map((row) => row.id));
  const disputed = pick(pools.disputed, Math.max(0, needDisputed - urgent.length), urgentIds);
  const control = pick(pools.control, needControl, new Set());
  const cases = interleave(urgent, disputed, control, opts.maxCases ?? Number.POSITIVE_INFINITY);

  const auditCount = Math.max(0, Math.floor(opts.audit ?? 0));
  const audit =
    auditCount === 0
      ? []
      : spreadPick([...pools.disputed.moved, ...pools.control.moved], auditCount);
  return {
    cases,
    populationDisputed: pools.disputed.unread.length + pools.disputed.stale.length,
    populationControl: pools.control.unread.length + pools.control.stale.length,
    ...nominating(pools, cases, priority),
    tally,
    audit,
  };
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
  meta: {
    model: string;
    fingerprint: string | null;
    judgedAt: Date;
    /** Each entry's identity: when given, a decided verdict is printed per tool (`labelPrint`). */
    identities?: ReadonlyMap<string, string>;
  },
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
      catalogFingerprint:
        meta.identities !== undefined && meta.fingerprint !== null
          ? labelPrint(meta.identities, meta.fingerprint, verdict.entryId, verdict.runnerUp)
          : meta.fingerprint,
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

export interface AdaptiveOptions {
  /** The margin the share needs, plus or minus; `DEFAULT_TARGET_MARGIN` when absent. */
  targetMargin?: number;
  roundSize?: number;
  maxRounds?: number;
  /** Wall-clock budget for all rounds together. */
  deadlineMs?: number;
  now?: () => number;
}

/**
 * All of a run's rounds together stop after this long. A round is not started
 * unless the slowest round so far still fits, so judging stays inside the
 * half of the job's time that judging is given (`JEV_MAX_DURATION_MS`).
 */
export const ADAPTIVE_DEADLINE_MS = 5 * 60_000;

/**
 * Run the judge (RC-394): ask a batch, fold the answers into the key,
 * re-estimate how many more the share needs, and ask again until the margin
 * is met, nothing is left, or the engine's budget, the deadline or the round
 * limit is reached. The first round also re-asks a sample of fresh verdicts
 * whose catalog moved since (the audit); when too few come back the same,
 * every such verdict counts as stale for the rounds that follow. Null when
 * nothing was worth judging.
 */
export async function judgeTargets(
  items: readonly EvalItem[],
  corpus: readonly CorpusEntry[],
  ourArm: string,
  baselineArm: string,
  engine: JudgeEngine,
  opts: {
    mocked?: boolean;
    priority?: ReadonlySet<string>;
    key?: ReadonlyMap<string, GroundTruthLabel>;
    fingerprint?: string;
    judgedAt?: Date;
    /** Tunes the loop (margin, round size, rounds, deadline); the defaults when absent. */
    adaptive?: AdaptiveOptions;
  } = {},
): Promise<{ items: EvalItem[]; census: JudgeCensus; labels: GroundTruthLabel[] } | null> {
  const tuning = opts.adaptive ?? {};
  const now = tuning.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + (tuning.deadlineMs ?? ADAPTIVE_DEADLINE_MS);
  const roundSize = Math.max(1, Math.floor(tuning.roundSize ?? ADAPTIVE_ROUND_SIZE));
  const maxRounds = Math.max(1, Math.floor(tuning.maxRounds ?? ADAPTIVE_MAX_ROUNDS));
  const targetMargin = tuning.targetMargin ?? DEFAULT_TARGET_MARGIN;
  const corpusIds = new Set(corpus.map((entry) => entry.entryId));
  const identities = entryIdentities(corpus);
  const capacity = engine.capacity?.(corpus);
  let remaining =
    capacity === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(capacity));
  const judgedAt = opts.judgedAt ?? new Date();
  const key = new Map(opts.key ?? []);
  const asked = new Set<string>();
  const allCases: JudgeCase[] = [];
  const allVerdicts: JudgeVerdict[] = [];
  const labels: GroundTruthLabel[] = [];
  let population: {
    disputed: number;
    control: number;
    nominatingPopulation: number;
    nominatingSampled: number;
  } | null = null;
  let audited = 0;
  let auditAgreed = 0;
  let audit: AdaptiveCensus["audit"] = "unknown";
  let rounds = 0;
  let stopped: AdaptiveCensus["stopped"] = "max_rounds";

  const sample = (round: number) =>
    sampleAdaptively(items, ourArm, baselineArm, {
      key,
      fingerprint: opts.fingerprint,
      corpusIds,
      identities,
      ...(opts.priority ? { priority: opts.priority } : {}),
      targetMargin,
      distrustMoved: audit === "distrust",
      // The drift sample and the audit belong to the run, so only the first round takes them.
      audit: round === 0 ? AUDIT_SAMPLE : 0,
      drift: round === 0 ? DRIFT_PER_STRATUM : 0,
      maxCases: Math.min(roundSize, remaining),
    });

  let slowestRoundMs = 0;
  const auditIds = new Set<string>();
  for (let round = 0; round < maxRounds; round += 1) {
    if (remaining <= 0) {
      stopped = "capacity";
      break;
    }
    if (now() + slowestRoundMs >= deadline) {
      stopped = "deadline";
      break;
    }
    const drawn = sample(round);
    population ??= {
      disputed: drawn.populationDisputed,
      control: drawn.populationControl,
      nominatingPopulation: drawn.nominatingPopulation,
      nominatingSampled: 0,
    };
    const fresh = drawn.cases.filter((row) => !asked.has(row.id));
    const auditCases = drawn.audit.filter(
      (row) => !asked.has(row.id) && !fresh.some((other) => other.id === row.id),
    );
    const cases = [...fresh, ...auditCases].slice(0, Math.max(0, remaining));
    if (cases.length === 0) {
      const needed = labelsNeeded([drawn.tally.disputed, drawn.tally.control], targetMargin).reduce(
        (a, b) => a + b,
        0,
      );
      stopped = needed === 0 ? "margin_met" : "nothing_left";
      break;
    }
    for (const row of cases) asked.add(row.id);
    const roundStartedAt = now();
    let returned: JudgeVerdict[];
    try {
      returned = await engine.judge(cases, corpus);
    } catch (error) {
      // The first round failing is the run's judge failing, as before. A later
      // one keeps what the earlier rounds bought instead of throwing it away.
      if (rounds === 0) throw error;
      stopped = "engine_failed";
      break;
    }
    rounds += 1;
    slowestRoundMs = Math.max(slowestRoundMs, now() - roundStartedAt);
    const verdicts = validateVerdicts(returned, new Set(cases.map((row) => row.id)), corpusIds);
    remaining -= cases.length;
    allCases.push(...cases);
    allVerdicts.push(...verdicts);

    // The audit: did the carried verdicts come back the same?
    for (const row of auditCases) auditIds.add(row.id);
    const caseById = new Map(cases.map((row) => [row.id, row]));
    for (const verdict of verdicts) {
      if (!auditCases.some((row) => row.id === verdict.id)) continue;
      const before = key.get(queryKey(caseById.get(verdict.id)?.query) ?? "");
      audited += 1;
      if (before !== undefined && before.entryId !== "" && before.entryId === verdict.entryId)
        auditAgreed += 1;
    }
    if (round === 0) audit = auditVerdict(auditAgreed, audited);

    const bought = labelsFromVerdicts(cases, verdicts, {
      model: engine.model,
      fingerprint: opts.fingerprint ?? null,
      judgedAt,
      identities,
    });
    for (const label of bought) key.set(label.queryKey, label);
    labels.push(...bought);
    // An engine that answered fewer than it was asked hit its own budget or deadline.
    if (verdicts.length < cases.length) {
      stopped = "engine_stopped";
      break;
    }
  }
  if (allCases.length === 0 || population === null) return null;

  const after = sampleAdaptively(items, ourArm, baselineArm, {
    key,
    fingerprint: opts.fingerprint,
    corpusIds,
    identities,
    targetMargin,
    distrustMoved: audit === "distrust",
  });
  const estimate = stratifiedShare([after.tally.disputed, after.tally.control]);
  const stillNeeded = labelsNeeded(
    [after.tally.disputed, after.tally.control],
    targetMargin,
  ).reduce((a, b) => a + b, 0);
  if (stopped === "max_rounds" && stillNeeded === 0) stopped = "margin_met";
  // The audit re-asks requests outside the sampled population (they were
  // fresh), so its answers move items but are kept out of the census.
  const sampledCases = allCases.filter((row) => !auditIds.has(row.id));
  const sampledVerdicts = allVerdicts.filter((verdict) => !auditIds.has(verdict.id));
  const censusPopulation = {
    ...population,
    nominatingSampled: sampledCases.filter(
      (row) => row.stratum === "disputed" && (opts.priority?.has(row.id) ?? false),
    ).length,
  };
  const model = { model: engine.model, mocked: opts.mocked ?? false };
  const applied = applyVerdicts(items, allCases, allVerdicts, censusPopulation, model, baselineArm);
  const counted = applyVerdicts(
    items,
    sampledCases,
    sampledVerdicts,
    censusPopulation,
    model,
    baselineArm,
  );
  return {
    items: applied.items,
    census: {
      ...counted.census,
      adaptive: {
        rounds,
        targetMargin,
        share: estimate.share,
        margin: estimate.margin,
        stillNeeded,
        audited,
        auditAgreed,
        audit,
        stopped,
      },
    },
    labels,
  };
}
