import type { ReplayCase } from "./replay";
import type { EvalItem, TargetSource } from "./types";

/**
 * The accumulating answer key: which tool each recorded request was asking for.
 *
 * WHY THIS IS A TABLE AND NOT A RUN COLUMN. A judged target used to live only in
 * the run that judged it, on `match_quality_eval_items.target_source = 'judge'`.
 * That made every judgment a disposable input to one week's proposals: the next
 * run re-froze the same window, saw only `reference` targets again, and either
 * paid to re-decide the same forty queries or simply went back to assuming the
 * incumbent was right. The knowledge existed and nothing could reach it.
 *
 * Stored per project and keyed on the QUERY rather than the selection, it turns
 * into the opposite: an asset that compounds. Every run spends its judging budget
 * on requests nobody has decided yet, so the labelled share of a project's history
 * climbs week over week at no extra cost, and a request asked again next month
 * already has its answer. That is what makes a backtest over the whole history
 * possible at all — a replay is only as good as the answer key it scores against.
 *
 * WHAT MAY BE STORED. Only evidence: a tool the agent actually ran, or a model's
 * explicit verdict. NEVER a reference target. "The incumbent's first result" is an
 * assumption the surface is careful to label as one everywhere else, and writing
 * it into a table called ground truth would launder it into a fact that every
 * later run would then treat as settled and never revisit.
 */

/**
 * How a durable label was established. Deliberately excludes `reference`.
 *
 * `unclear` is a judge that read the request and could not decide it. It is
 * stored so the request is not paid for again every week, and it is never used
 * as a target: an unclear search is left out of every number.
 */
export const LABEL_SOURCES = ["invoked", "judge", "unclear"] as const;
export type LabelSource = (typeof LABEL_SOURCES)[number];

export interface GroundTruthLabel {
  /** Normalized query text: the identity this label is stored against. */
  queryKey: string;
  /** The verbatim wording of the most recent sighting, for display. */
  query: string;
  /** Empty for an `unclear` label. */
  entryId: string;
  source: LabelSource;
  /** False when a judge answered but called it close. */
  confident: boolean;
  /** The judging model, or null for an observed invocation. */
  model: string | null;
  /** The most recent selection this was seen on, so it can be linked out to. */
  selectionId: string | null;
  /** How many times this request has been seen. */
  occurrences: number;
  observedAt: Date;
  /** The judge's confidence in [0, 1]; null for an invocation or an older verdict. */
  confidence?: number | null;
  /** The judge's second choice, when it gave one. */
  runnerUp?: string | null;
  /** Tool-identity fingerprint the verdict was made against; see `identityFingerprint`. */
  catalogFingerprint?: string | null;
}

/**
 * The identity two sightings of the same request share.
 *
 * Case-folded and whitespace-collapsed, matching the judge's own deduplication so
 * that a query the judge treated as one case cannot become two labels. Null for a
 * request whose text was never captured: with content capture off there is nothing
 * to key on, and keying on the selection id instead would mint a label that can
 * never match anything again.
 */
export function queryKey(query: string | null | undefined): string | null {
  if (typeof query !== "string") return null;
  const key = query.trim().toLowerCase().replace(/\s+/g, " ");
  return key.length === 0 ? null : key;
}

/** Strength order. An observed invocation outranks any opinion about one. */
const RANK: Record<LabelSource, number> = { invoked: 2, judge: 1, unclear: 1 };

/**
 * Fold a new sighting into what is already known about a request.
 *
 * Two rules, and the first one dominates: a stronger source always wins, so a
 * judge can never overwrite an observed invocation no matter how recent it is.
 * Between two sightings of equal strength the newer one wins, which is what lets
 * a re-judgment correct an earlier mistake once the catalog has changed under it.
 *
 * The occurrence count accumulates either way, because it measures how often the
 * request is asked and that is true regardless of which answer survived.
 */
export function mergeLabel(
  existing: GroundTruthLabel | null,
  incoming: GroundTruthLabel,
): GroundTruthLabel {
  if (existing === null) return incoming;

  const occurrences = existing.occurrences + incoming.occurrences;
  const stronger = RANK[incoming.source] > RANK[existing.source];
  const sameStrengthButNewer =
    RANK[incoming.source] === RANK[existing.source] &&
    incoming.observedAt.getTime() > existing.observedAt.getTime();

  return stronger || sameStrengthButNewer
    ? { ...incoming, occurrences }
    : { ...existing, occurrences };
}

/**
 * Everything one run's frozen evidence is worth keeping.
 *
 * Deduplicated within the batch by the same merge rule the store uses, so a run
 * that saw one request forty times writes one row carrying the count rather than
 * forty conflicting upserts racing each other inside a single statement.
 */
export function harvestLabels(items: readonly EvalItem[]): GroundTruthLabel[] {
  const byKey = new Map<string, GroundTruthLabel>();

  for (const item of items) {
    // Only behaviour is harvested from items. A judged item's label came from
    // the key or from this run's verdicts (`labelsFromVerdicts`), and re-minting
    // it here would stamp an old verdict with a new date, model and fingerprint.
    if (item.targetSource !== "invoked") continue;
    const key = queryKey(item.query);
    if (key === null) continue;

    const incoming: GroundTruthLabel = {
      queryKey: key,
      query: (item.query ?? "").trim(),
      entryId: item.targetEntryId,
      source: "invoked",
      confident: true,
      // Only a verdict has a model behind it. Recording one against an observed
      // invocation would credit a model for a fact it had no part in.
      model: null,
      selectionId: item.selectionId,
      occurrences: 1,
      observedAt: item.occurredAt,
    };
    byKey.set(key, mergeLabel(byKey.get(key) ?? null, incoming));
  }

  return [...byKey.values()];
}

/**
 * Upgrade one run's frozen items from the answer key, before anything reads them.
 *
 * This is what makes the key compound. `freezeEvidence` can only ever mark a
 * target `reference` when no invocation was recorded, because it reads telemetry
 * and telemetry does not remember what a judge decided last month. Applying the
 * key here, BEFORE the judge samples, does two things at once:
 *
 *   - the judge's sampler skips these items, since it only ever draws from
 *     `reference`, so every call this run pays for buys a NEW answer
 *   - the candidate picker sees the corrected target, so a rewrite is nominated
 *     against what the request actually wanted rather than what the incumbent
 *     guessed, without re-buying the verdict that established it
 *
 * Only `reference` items are touched. An invocation recorded for THIS search
 * outranks a label harvested from a different sighting of the same wording, so a
 * run's own behavioural evidence is never overwritten by the key.
 */
export function applyLabels(
  items: readonly EvalItem[],
  labels: ReadonlyMap<string, GroundTruthLabel>,
): EvalItem[] {
  if (labels.size === 0) return [...items];
  return items.map((item) => {
    if (item.targetSource !== "reference") return item;
    const key = queryKey(item.query);
    if (key === null) return item;
    const known = labels.get(key);
    // An unclear label is an answer of "nobody can say", never a target.
    if (!known || known.source === "unclear" || known.entryId === "") return item;
    return {
      ...item,
      targetEntryId: known.entryId,
      // A label is never `reference`, so this always promotes off the assumed
      // tier. `invoked` is carried through as such: the answer came from a real
      // invocation, even though it was a different sighting of the request.
      targetSource: known.source,
    };
  });
}

/**
 * The population a backtest replays: the frozen history, with its targets
 * upgraded wherever the answer key knows better.
 *
 * `items` are the eval items every run has ever frozen, which is the only record
 * of these searches that survives `otel_logs` being pruned at thirty days. They
 * arrive newest first; the newest sighting of a repeated request is the one kept,
 * so the served lists replayed against are the most recent ones.
 *
 * A search with no real answer (no invocation, no verdict, or an unclear one) is
 * LEFT OUT. It used to be replayed against the incumbent's first result and
 * counted separately; now that every distinct request can be judged cheaply,
 * scoring anything against an assumption is no longer worth the confusion.
 */
export function buildReplayCases(
  items: readonly EvalItem[],
  labels: ReadonlyMap<string, GroundTruthLabel>,
  ourArm: string,
  baselineArm: string,
): ReplayCase[] {
  const byKey = new Map<string, ReplayCase>();

  for (const item of items) {
    const key = queryKey(item.query);
    if (key === null) continue;

    const existing = byKey.get(key);
    if (existing && existing.occurredAt.getTime() >= item.occurredAt.getTime()) continue;

    const stored = labels.get(key);
    const unclear = stored !== undefined && (stored.source === "unclear" || stored.entryId === "");
    const known = stored && !unclear ? stored : undefined;
    // No answer: never judged, or judged unclear since this sighting was frozen
    // (an older `judge` target on a history row does not outrank a newer
    // "nobody can say"). Only a recorded invocation survives an unclear key.
    if (
      !known &&
      (item.targetSource === "reference" || (unclear && item.targetSource !== "invoked"))
    ) {
      continue;
    }
    const ours = item.arms.find((arm) => arm.arm === ourArm);
    const baseline = item.arms.find((arm) => arm.arm === baselineArm);

    byKey.set(key, {
      queryKey: key,
      query: (item.query ?? "").trim(),
      targetEntryId: known?.entryId ?? item.targetEntryId,
      source: (known?.source ?? item.targetSource) as TargetSource,
      servedIds: ours ? [...ours.resultIds] : null,
      baselineIds: baseline ? [...baseline.resultIds] : null,
      occurredAt: item.occurredAt,
    });
  }

  return [...byKey.values()];
}

/**
 * The share of a replay population whose answer is known rather than assumed.
 *
 * Published beside every backtest figure, because it is the one number that says
 * how much the rest of them are worth. Null rather than zero for an empty
 * population: no searches is an absence, and a "0% labelled" chip on a page with
 * nothing on it reads as a failure rather than as an empty start.
 */
export function labelledShare(cases: readonly ReplayCase[]): number | null {
  if (cases.length === 0) return null;
  const labelled = cases.filter((row) => row.source !== "reference").length;
  return labelled / cases.length;
}
