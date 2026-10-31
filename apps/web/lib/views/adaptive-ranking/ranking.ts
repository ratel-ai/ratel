/**
 * Adaptive ranking in one reading (DESIGN.md, One question per page: "Does
 * adaptive ranking help?"): whether a graph is served, one headline from the
 * with-and-without comparison, the curve behind it, and how far the graph has
 * learned. Pure, over the Boost view the v1 panel already computes, so both
 * versions tell the same numbers. Recall@k, nDCG and MRR stay behind Details.
 */

import {
  type IntentGraphProducer,
  MAX_INTENT_GRAPH_BYTES,
  MAX_INTENT_GRAPH_CLUSTERS,
} from "@/lib/readings/intent-types/wire";
import { type ConfidenceInterval, wilsonInterval } from "@/lib/readings/stats";
import { separated } from "@/lib/synthesis/quality/metrics";
import {
  BOOST_METRICS,
  BOOST_MIN_TURNS,
  type BoostMetric,
  type BoostTurn,
  type BoostView,
} from "@/lib/views/adaptive-ranking/boost-view";
import type { CloudGraphState } from "@/lib/views/intents/adaptive-view";

/** A share is shown, and a difference claimed, only from this many matched searches. */
export const HEADLINE_MIN_SEARCHES = BOOST_MIN_TURNS;
/** Points the simplified chart draws at most; longer runs are thinned evenly. */
export const CURVE_POINTS = 120;

/**
 * `better` and `worse` only when the two shares' Wilson intervals separate;
 * `same` when they overlap; `none` below the minimum; `unscored` when searches
 * arrive but none reported the tool the agent ran.
 */
export type HeadlineState = "better" | "same" | "worse" | "none" | "unscored";

export interface RankingHeadline {
  state: HeadlineState;
  /** Share of matched searches with the right tool first, with the graph and without it. */
  withGraph: number | null;
  without: number | null;
  /** 95% Wilson intervals on the two shares; null below the minimum. */
  intervals: { withGraph: ConfidenceInterval; without: ConfidenceInterval } | null;
  /** Matched searches: both lists scored on the same search, against the tool the agent ran. */
  searches: number;
  /** Every search the comparison read, matched or not. */
  seen: number;
  /** Relative change in that share: 0.15 reads "15% more often". Null when the share without it is 0. */
  relative: number | null;
  /** The same change in percentage points. */
  points: number | null;
  /** The one line, e.g. "Finds the right tool first 15% more often". */
  title: string;
  /** The numbers behind it, in one sentence. */
  detail: string;
  /** True when no runtime serves the graph yet, so the reading is what it would do. */
  projected: boolean;
  /** True when some rankings are Cloud's own replay rather than what a runtime served. */
  estimated: boolean;
  /** The agent picked from the graph's own list on these searches, so the share with it is an upper bound. */
  upperBound: boolean;
  /** Before the switch the agent saw the list without the graph, after it the graph's. */
  mixed: boolean;
  /** What to keep in mind reading it: an estimate, an upper bound, a switch. Plain sentences. */
  notes: string[];
}

/** The caveats a reading carries, in the order they matter. */
function headlineNotes(view: BoostView, flags: { upperBound: boolean; mixed: boolean }): string[] {
  const notes: string[] = [];
  if (view.estimated) {
    notes.push(
      view.reported
        ? "Searches a runtime served are what it reported, with and without the graph; the rest are estimated by replaying your searches on Cloud's keyword index."
        : "Estimated by replaying your searches on Cloud's keyword index, with and without the graph as it stood at each search. Your runtime's own ranking may differ.",
    );
  }
  if (flags.upperBound) {
    notes.push(
      "Your agent saw the graph's ranking for these searches and could only pick from it, so read the share with it as an upper bound.",
    );
  }
  if (flags.mixed) {
    notes.push(
      "Before the switch your agent saw the results without the graph; after it, the graph's ranking, so the share with it is partly an upper bound.",
    );
  }
  return notes;
}

const pct = (value: number) => `${Math.round(value * 100)}%`;
const count = (value: number) => value.toLocaleString("en-US");

/**
 * The searches every reading on this page is taken over: both lists scored on
 * the same search, against the tool the agent ran after it (a search that
 * reported no tool call has nothing to score). Once a runtime serves the
 * graph, only the searches it served.
 */
export function matchedTurns(view: BoostView): BoostTurn[] {
  const online =
    view.online.fromTurn !== null && view.turns.some((turn) => turn.phase === "online");
  return view.turns.filter(
    (turn) =>
      (!online || turn.phase === "online") &&
      turn.tier === "revealed" &&
      turn.score["recall@1"].reference !== null &&
      turn.score["recall@1"].adaptive !== null,
  );
}

export function rankingHeadline(view: BoostView, served: boolean): RankingHeadline {
  const projected = !served;
  const matched = matchedTurns(view);
  const searches = matched.length;
  const seen = view.turns.length + view.evidence.skipped;
  const bias = view.evidence.bias.adaptive;
  const flags = {
    upperBound: searches > 0 && bias === "self-selected",
    mixed: searches > 0 && bias === "mixed",
  };
  const base = {
    searches,
    seen,
    projected,
    estimated: view.estimated,
    ...flags,
    notes: headlineNotes(view, flags),
  };
  const blank = {
    ...base,
    withGraph: null,
    without: null,
    intervals: null,
    relative: null,
    points: null,
  };

  if (seen > 0 && view.evidence.revealed === 0) {
    return {
      ...blank,
      state: "unscored",
      title: `None of the ${count(seen)} ${seen === 1 ? "search" : "searches"} reported the tool the agent ran`,
      detail:
        "The comparison scores the first result against the tool the agent ran after a search, so it needs each tool call linked to its search (search_id). It fills in as those arrive.",
    };
  }
  if (searches < HEADLINE_MIN_SEARCHES) {
    return {
      ...blank,
      state: "none",
      title: "Not enough searches to compare yet",
      detail:
        searches === 0
          ? `The comparison needs ${HEADLINE_MIN_SEARCHES} searches that reported the tool the agent ran. It fills in as traffic arrives.`
          : `${count(searches)} of the ${HEADLINE_MIN_SEARCHES} searches the comparison needs have reported the tool the agent ran. It fills in as traffic arrives.`,
    };
  }

  const wins = (arm: "adaptive" | "reference") =>
    matched.filter((turn) => turn.score["recall@1"][arm] === 1).length;
  const withWins = wins("adaptive");
  const withoutWins = wins("reference");
  const withGraph = withWins / searches;
  const without = withoutWins / searches;
  const intervals = {
    withGraph: wilsonInterval(withWins, searches)!,
    without: wilsonInterval(withoutWins, searches)!,
  };
  const relative = without > 0 ? (withGraph - without) / without : null;
  const points = Math.round((withGraph - without) * 100);
  const state: HeadlineState = !separated(intervals.withGraph, intervals.without)
    ? "same"
    : withGraph > without
      ? "better"
      : "worse";

  const verb = projected ? "Would find" : "Finds";
  let title: string;
  if (state === "same") title = `${verb} the right tool first about as often as without it`;
  else if (without === 0)
    title = `${projected ? "Would put" : "Puts"} the right tool first on ${pct(withGraph)} of searches, up from none without it`;
  else if (withGraph === 0)
    title = `${projected ? "Would never put" : "Never puts"} the right tool first, against ${pct(without)} of searches without it`;
  else
    title = `${verb} the right tool first ${Math.round(Math.abs(relative!) * 100)}% ${state === "better" ? "more" : "less"} often`;

  const subject = projected
    ? "With adaptive ranking the right tool would have come first"
    : "With adaptive ranking the right tool came first";
  const detail =
    `${subject} on ${pct(withGraph)} of ${count(searches)} searches that reported the tool the agent ran, against ${pct(without)} without it.` +
    (state === "same" ? " The gap is within what chance alone gives on this many searches." : "");
  return { ...base, state, withGraph, without, intervals, relative, points, title, detail };
}

export interface RankingMetricValue {
  id: BoostMetric;
  without: number | null;
  withGraph: number | null;
}

/** Every metric over the same matched searches as the headline, so Details and the headline never disagree. */
export function rankingMetrics(view: BoostView): RankingMetricValue[] {
  const matched = matchedTurns(view);
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return BOOST_METRICS.map((metric) => {
    if (matched.length === 0) return { id: metric.id, without: null, withGraph: null };
    return {
      id: metric.id,
      without: mean(matched.map((turn) => turn.score[metric.id].reference ?? 0)),
      withGraph: mean(matched.map((turn) => turn.score[metric.id].adaptive ?? 0)),
    };
  });
}

export interface CurvePoint {
  turn: number;
  without: number | null;
  withGraph: number | null;
}

/**
 * The running share with the right tool first, with the graph and without it,
 * over the matched searches in order, from the first point that averages
 * enough searches to mean something, thinned to at most `max` points. `turn`
 * counts matched searches, so the last point, always kept, is the headline.
 */
export function rankingCurve(view: BoostView, max: number = CURVE_POINTS): CurvePoint[] {
  const points: CurvePoint[] = [];
  let withWins = 0;
  let withoutWins = 0;
  matchedTurns(view).forEach((turn, index) => {
    if (turn.score["recall@1"].adaptive === 1) withWins += 1;
    if (turn.score["recall@1"].reference === 1) withoutWins += 1;
    const searches = index + 1;
    if (searches >= HEADLINE_MIN_SEARCHES)
      points.push({
        turn: searches,
        withGraph: withWins / searches,
        without: withoutWins / searches,
      });
  });
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, index) => points[Math.round(index * step)]!);
}

export interface ServingState {
  tone: "neutral" | "success";
  label: string;
  sentence: string;
  served: boolean;
}

/** Whether a graph changes what the agent sees, in words. */
export function servingState(
  producer: IntentGraphProducer,
  state: CloudGraphState | null,
): ServingState {
  if (producer !== "cloud") {
    return {
      tone: "success",
      label: "Served by its runtime",
      sentence: "A runtime learned this graph itself and ranks from it.",
      served: true,
    };
  }
  if (state === "boosting") {
    return {
      tone: "success",
      label: "Served",
      sentence: "A runtime ranks from this graph and changed results with it in the last day.",
      served: true,
    };
  }
  if (state === "live") {
    return {
      tone: "success",
      label: "Served",
      sentence:
        "A runtime ranks from this graph. None has changed a result with it in the last day.",
      served: true,
    };
  }
  return {
    tone: "neutral",
    label: "Not served yet",
    sentence:
      "Cloud builds this graph and compares it with your current ranking. No runtime ranks from it yet.",
    served: false,
  };
}

export interface PercentDomain {
  low: number;
  high: number;
  ticks: number[];
}

/**
 * The y-axis for the right-tool-first chart: fitted to the curves with a
 * little headroom, on round 5 or 10 point steps. A full 0 to 100% axis flattens
 * a 10 point lift into a line; fitting it is what makes the gap readable.
 */
export function percentDomain(values: readonly (number | null)[]): PercentDomain {
  const finite = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  if (finite.length === 0) return { low: 0, high: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const pad = Math.max(0.02, (max - min) * 0.15);
  const span = Math.min(1, max + pad) - Math.max(0, min - pad);
  const step = span <= 0.3 ? 0.05 : span <= 0.6 ? 0.1 : 0.25;
  const low = Math.max(0, Math.floor((min - pad) / step) * step);
  const high = Math.min(1, Math.ceil((max + pad) / step) * step);
  const count = Math.round((high - low) / step);
  const ticks = Array.from(
    { length: count + 1 },
    (_, index) => Math.round((low + index * step) * 1000) / 1000,
  );
  return { low: ticks[0]!, high: ticks[ticks.length - 1]!, ticks };
}

/** A setup step in the checklist's terms: done, the one to do now, later, or wrong. */
export type ChecklistState = "done" | "current" | "todo" | "problem";

export interface ChecklistStep {
  key: string;
  title: string;
  detail: string;
  state: ChecklistState;
  snippet?: string;
}

/**
 * The whole way from no traffic to a served graph, as one numbered list:
 * the project's steps (events arriving, the graph building) then the graph's
 * (a runtime ranks from it, and follows its updates). The first step not done
 * is the one to do now; the ones after it wait.
 */
export function rankingChecklist(
  steps: ReadonlyArray<{
    key: string;
    label: string;
    detail: string;
    state: "done" | "pending" | "problem";
    snippet?: string;
  }>,
): ChecklistStep[] {
  let current = false;
  return steps.map((step) => {
    let state: ChecklistState;
    if (step.state === "done") state = "done";
    else if (step.state === "problem") state = "problem";
    else if (!current) state = "current";
    else state = "todo";
    if (state === "current" || state === "problem") current = true;
    return {
      key: step.key,
      title: step.label,
      detail: step.detail,
      state,
      ...(step.snippet ? { snippet: step.snippet } : {}),
    };
  });
}

export interface GraphGrowth {
  /** Share of ask groups seen often enough to rank at full weight, 0..1. */
  learned: number;
  /** The larger of the group and size budgets used, 0..1. */
  used: number;
  usedLabel: string;
}

export function graphGrowth(input: {
  maturity: number;
  clusterCount: number;
  byteSize: number;
}): GraphGrowth {
  const clamp = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
  const groups = clamp(input.clusterCount / MAX_INTENT_GRAPH_CLUSTERS);
  const bytes = clamp(input.byteSize / MAX_INTENT_GRAPH_BYTES);
  return {
    learned: clamp(input.maturity),
    used: Math.max(groups, bytes),
    usedLabel: `${input.clusterCount.toLocaleString("en-US")} of ${MAX_INTENT_GRAPH_CLUSTERS.toLocaleString("en-US")} ask groups`,
  };
}
