import { and, asc, desc, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";
import type { ExperimentWindow } from "@/lib/synthesis/experiments/service";
import {
  type EvaluableSelection,
  pickBaselineArm,
  referenceTarget,
  resolveAttributionMode,
} from "@/lib/synthesis/quality/ground-truth";
import type { QualitySelectionDiagnostics } from "@/lib/synthesis/quality/queries";
import type { EvalArm, EvalItem, RevealedSource, RunCensus } from "./types";

/**
 * Turning a window of telemetry into the frozen evaluation set a run reasons over
 * and a future backtest replays.
 *
 * Everything about the experiment lane is read through `lib/quality`. This module
 * writes no SQL against `otel_logs`: the meter already knows how to join a
 * comparison to its per-arm results, which vocabulary keys name an invoked tool,
 * and why the baseline must be chosen by NAME rather than by which arm served.
 * Re-deriving any of that here would produce a second, quietly different answer
 * sitting one click away from the first.
 *
 * What IS new here is the second source of revealed evidence. See
 * {@link loadInvokedToolsBySearchId}.
 *
 * The output is deliberately a value, not a query: once frozen, a run's evidence
 * never changes, which is what makes a later backtest reproducible and what keeps
 * it answerable at all after `otel_logs` is pruned at thirty days.
 */

/**
 * How many searches one run freezes.
 *
 * The cap is what keeps a run's cost and duration flat as a partner's traffic
 * grows: everything downstream reads this set and nothing reads the window
 * again. A busy month and a quiet one cost the same.
 */
export const MAX_EVAL_ITEMS = 1_000;

/**
 * Thin a window down to the cap by taking an even stride across it.
 *
 * NOT the newest N, which is what this used to do and what quietly turns a
 * thirty-day run into a fourteen-hour one once a project is busy enough to
 * overrun the cap. Everything the run then says is scoped to that slice while
 * the page still says thirty days: the candidate ranking, the diagnosis, and
 * worst of all the measured worth of the incumbent, which is published as a
 * property of the window.
 *
 * A stride keeps the window meaning what it says. It costs nothing, it is
 * deterministic, and it is the same shape the judge's control stratum already
 * uses for the same reason. Ordering is preserved, so the newest-first
 * invariants downstream still hold; the set is thinned, not reshuffled.
 */
function spreadAcross<T>(rows: readonly T[], limit: number): T[] {
  if (rows.length <= limit) return [...rows];
  const step = rows.length / limit;
  const picked: T[] = [];
  for (let index = 0; index < limit; index += 1) {
    const row = rows[Math.floor(index * step)];
    if (row !== undefined) picked.push(row);
  }
  return picked;
}

export type EvidenceDb = Pick<ReturnType<typeof getDb>, "select">;

/** The `trace_events.type` values that name a tool the agent actually ran. */
const INVOKE_TYPES = ["invoke_start", "invoke_end", "gateway_invoke"] as const;

/**
 * Invoked tool ids keyed by the search they followed, from the runtime-facts lane.
 *
 * `trace_events.search_id` is validated, promoted and persisted end to end today,
 * and nothing reads it: the SDK does not populate it yet. Acme have said they
 * will start sending it, and when they do this is the join that turns their
 * revealed tier on with no further Cloud change, so it is wired now rather than
 * left as a schema comment.
 *
 * Widened past the window on purpose. An invocation follows its search by
 * definition, so a search near the upper edge of a window has its invoke recorded
 * just outside it. Bounding this read by the same window would silently drop
 * exactly the most recent evidence. Same rule the existing calibration queries
 * follow for per-arm `results` records.
 */
export async function loadInvokedToolsBySearchId(
  projectId: string,
  searchIds: readonly string[],
  window: ExperimentWindow,
  db: EvidenceDb = getDb(),
): Promise<Map<string, string>> {
  const bySearch = new Map<string, string>();
  if (searchIds.length === 0) return bySearch;

  // An invocation cannot precede its search, and one that lands more than an hour
  // later is a different session reusing an id rather than a follow-through.
  const until = new Date(window.until.getTime() + 60 * 60 * 1000);

  const rows = await db
    .select({
      searchId: traceEvents.searchId,
      toolId: traceEvents.toolId,
    })
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        inArray(traceEvents.type, [...INVOKE_TYPES]),
        isNotNull(traceEvents.searchId),
        isNotNull(traceEvents.toolId),
        inArray(traceEvents.searchId, [...searchIds]),
        gte(traceEvents.occurredAt, window.since),
        lte(traceEvents.occurredAt, until),
      ),
    )
    // Ordered so "the first invocation wins" is a fact about time rather than
    // about whatever order the planner happened to return rows in.
    .orderBy(asc(traceEvents.occurredAt));

  for (const row of rows) {
    if (!row.searchId || !row.toolId) continue;
    // The earliest invocation is the one this search led to. A later one in the
    // same session is the agent moving on to its next step.
    if (!bySearch.has(row.searchId)) bySearch.set(row.searchId, row.toolId);
  }
  return bySearch;
}

/**
 * Which arm's lists we are tuning, i.e. ours.
 *
 * NOT "the arm that served". That heuristic is right in Acme production, where
 * Ratel serves and their legacy search shadows behind it, and wrong everywhere
 * else, including in our own demo fixture where legacy serves and Ratel shadows.
 * Taking the serving arm there rewrites descriptions to fix the INCUMBENT's
 * misses, scored against the incumbent's own lists, which is both useless and
 * invisible: the run completes, proposes plausible text, and tunes for a corpus
 * nobody is editing.
 *
 * The corpus this feature can edit is always ours, so the arm is defined by
 * exclusion: whichever one the name-based baseline picker did not choose. With
 * more than two arms the busiest non-baseline one wins.
 */
export function pickTunedArm(
  selections: readonly EvaluableSelection[],
  baselineArm: string | null,
): string | null {
  const counts = new Map<string, number>();
  for (const selection of selections) {
    for (const arm of selection.arms) {
      if (arm.arm === baselineArm) continue;
      counts.set(arm.arm, (counts.get(arm.arm) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1),
  );
  return ranked[0]?.[0] ?? null;
}

function toEvalArms(selection: EvaluableSelection): EvalArm[] {
  return selection.arms.map((arm) => ({
    arm: arm.arm,
    role: arm.role,
    resultIds: [...arm.resultIds],
    resultScores: arm.resultScores ? [...arm.resultScores] : null,
  }));
}

export interface FrozenEvidence {
  items: EvalItem[];
  census: RunCensus;
}

/**
 * Freeze a window's selections into evaluation items, and census what was there.
 *
 * A selection with no target under either tier is DROPPED rather than counted as
 * a miss, for the reason `observeSelections` already documents: "the agent never
 * ran anything" is not evidence that retrieval failed, and folding it in drags
 * every arm down by however sparse the telemetry happens to be.
 *
 * `invokedBySearchId` is the runtime-facts lane; `selection.invokedToolId` is the
 * experiment lane. The experiment lane wins a tie because it is the one the
 * quality meter scores against, so a run and the meter beside it never disagree
 * about what the right answer was.
 */
export function freezeEvidence(
  selections: readonly EvaluableSelection[],
  diagnostics: QualitySelectionDiagnostics,
  invokedBySearchId: ReadonlyMap<string, string> = new Map(),
  limit: number = MAX_EVAL_ITEMS,
): FrozenEvidence {
  // A baseline needs a second engine to be one. Search telemetry records only
  // Ratel, and `pickBaselineArm` would otherwise crown that single arm the
  // incumbent and leave nothing to tune.
  const armNames = new Set(selections.flatMap((selection) => selection.arms.map((arm) => arm.arm)));
  const baselineArm = armNames.size > 1 ? pickBaselineArm(selections) : null;
  const servingArm =
    selections.flatMap((selection) => selection.arms).find((arm) => arm.role === "serving")?.arm ??
    null;

  // Newest first, so the survivor of a duplicate query downstream is the most
  // recent one and the ordering invariants hold. When the cap binds the set is
  // thinned by stride rather than truncated, so the run still covers the window
  // it claims to.
  const ordered = [...selections].sort(
    (left, right) => right.occurredAt.getTime() - left.occurredAt.getTime(),
  );
  const truncated = ordered.length > limit;
  const considered = spreadAcross(ordered, limit);

  const items: EvalItem[] = [];
  let revealedN = 0;
  let referenceN = 0;
  let queriesCaptured = 0;
  let fromExperiment = 0;
  let fromTraceEvents = 0;

  for (const selection of considered) {
    const fromLane = invokedBySearchId.get(selection.selectionId) ?? null;
    const invoked = selection.invokedToolId ?? fromLane;
    if (selection.invokedToolId !== null) fromExperiment += 1;
    else if (fromLane !== null) fromTraceEvents += 1;

    // A search with no invocation is kept even when there is no baseline to
    // name a placeholder: it has no answer yet ("" on the reference tier), and
    // the judge or the answer key is what gives it one.
    const target =
      invoked ?? (baselineArm === null ? "" : (referenceTarget(selection, baselineArm) ?? ""));

    if (invoked !== null) revealedN += 1;
    else referenceN += 1;
    if ((selection.query ?? "").trim().length > 0) queriesCaptured += 1;

    items.push({
      selectionId: selection.selectionId,
      occurredAt: selection.occurredAt,
      query: selection.query,
      targetEntryId: target,
      targetKind: "tool",
      targetSource: invoked !== null ? "invoked" : "reference",
      arms: toEvalArms(selection),
    });
  }

  return {
    items,
    census: {
      selectionsEvaluated: items.length,
      revealedN,
      referenceN,
      judgedN: 0,
      queriesCaptured,
      truncated,
      attributionMode: resolveAttributionMode({
        toolIds: fromExperiment + fromTraceEvents,
        recordedRanks: diagnostics.recordedRankCount,
      }),
      invokedToolKey: diagnostics.invokedToolKey,
      revealedSource: revealedSourceOf(fromExperiment, fromTraceEvents),
      baselineArm,
      servingArm,
      tunedArm: pickTunedArm(considered, baselineArm),
    },
  };
}

function revealedSourceOf(experiment: number, traceLane: number): RevealedSource {
  if (experiment > 0 && traceLane > 0) return "both";
  if (experiment > 0) return "experiment-invocation";
  if (traceLane > 0) return "trace-events";
  return "none";
}

/**
 * Whether a census is worth a model call.
 *
 * The floors exist because of what today's partner telemetry actually looks like:
 * zero invocation records and content capture off for most searches. A run over
 * that has a handful of baseline-agreement targets and no query text, and a model
 * asked to rewrite descriptions from it will produce confident, ungrounded prose,
 * because that is what a model does with a thin prompt.
 *
 * So a thin window is a successful run that proposes nothing and says why. That is
 * a more useful answer than a page of invented rewrites, and it is the honest one.
 */
export const MIN_EVALUABLE_SEARCHES = 20;
export const MIN_CAPTURED_QUERIES = 5;

export function declineReason(census: RunCensus): string | null {
  if (census.selectionsEvaluated < MIN_EVALUABLE_SEARCHES) {
    return (
      `Only ${census.selectionsEvaluated} search(es) in this window could be scored, ` +
      `below the ${MIN_EVALUABLE_SEARCHES} needed to tell a real pattern from noise. ` +
      "Widen the window, or check that searches are still being recorded."
    );
  }
  if (census.queriesCaptured < MIN_CAPTURED_QUERIES) {
    return (
      `Only ${census.queriesCaptured} of ${census.selectionsEvaluated} scored search(es) ` +
      "have their query text stored, so there is almost nothing to read about what users " +
      "actually asked. Turn on content capture in the SDK to make this window usable."
    );
  }
  return null;
}

/**
 * What retrieval actually did in this window, read from telemetry.
 *
 * Cloud stores no per-project retrieval configuration: `mode` and
 * `embeddingWeight` exist only as per-request Playground parameters, so there is
 * no settings row to quote at the model. The SDK does, however, report the stages
 * a search ran through, preserved verbatim in `trace_events.payload` (the parser
 * keeps unknown fields rather than stripping them, which is the only reason this
 * is readable at all).
 *
 * So this is an OBSERVATION, and it is labelled as one all the way into the
 * prompt. Where no search reported stages, the answer is "not observed", never a
 * guess at a default: a model told a dense pass ran when it did not will tune for
 * semantic similarity that nothing is measuring.
 */
export interface RetrievalObservationResult {
  stages: string[];
  topK: number | null;
  samples: number;
}

/** One search's payload, as far as this cares. */
interface SearchPayload {
  stages?: unknown;
}

function stageNames(value: unknown): string[] {
  if (typeof value === "string") {
    // "bm25 -> dense -> rrf" and "bm25,dense,rrf" both appear in the wild.
    return value
      .split(/->|,/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((stage) => {
      if (typeof stage === "string") return stage.trim();
      if (stage && typeof stage === "object") {
        const record = stage as Record<string, unknown>;
        const name = record.name ?? record.stage ?? record.kind;
        return typeof name === "string" ? name.trim() : "";
      }
      return "";
    })
    .filter((name) => name.length > 0);
}

export async function observeRetrieval(
  projectId: string,
  window: ExperimentWindow,
  db: EvidenceDb = getDb(),
  limit = 200,
): Promise<RetrievalObservationResult> {
  const rows = await db
    .select({ payload: traceEvents.payload, topK: traceEvents.topK })
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        eq(traceEvents.type, "search"),
        gte(traceEvents.occurredAt, window.since),
        lte(traceEvents.occurredAt, window.until),
      ),
    )
    .orderBy(desc(traceEvents.occurredAt))
    .limit(limit);

  // The most common stage list wins rather than the most recent, so one odd
  // search does not redescribe the whole window's configuration.
  const counts = new Map<string, { stages: string[]; count: number }>();
  let topK: number | null = null;
  let samples = 0;

  for (const row of rows) {
    if (topK === null && typeof row.topK === "number") topK = row.topK;
    const stages = stageNames((row.payload as SearchPayload | null)?.stages);
    if (stages.length === 0) continue;
    samples += 1;
    const key = stages.join(">");
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { stages, count: 1 });
  }

  const best = [...counts.values()].sort((left, right) => right.count - left.count)[0];
  return { stages: best?.stages ?? [], topK, samples };
}

/**
 * Re-derive the per-tier counts from the items themselves.
 *
 * Called after judging, which moves items off the reference tier one at a time.
 * Counting the items rather than adjusting the numbers means the census can
 * never drift from the set it describes, which is the failure the whole census
 * exists to prevent.
 */
export function recountTiers(items: readonly EvalItem[], census: RunCensus): RunCensus {
  let revealedN = 0;
  let referenceN = 0;
  let judgedN = 0;
  for (const item of items) {
    if (item.targetSource === "invoked") revealedN += 1;
    else if (item.targetSource === "judge") judgedN += 1;
    else referenceN += 1;
  }
  return { ...census, revealedN, referenceN, judgedN };
}
