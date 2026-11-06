import { type ConfidenceInterval, wilsonInterval } from "@/lib/readings/stats";
import {
  type EvaluableSelection,
  type EvidenceTier,
  type RevealedBias,
  rankOf,
  revealedArmBias,
  revealedTarget,
} from "@/lib/synthesis/quality/ground-truth";
import { rankCredit } from "@/lib/synthesis/quality/metrics";

/**
 * Pure view model for the Boost panel: does the intent graph move the target
 * up the list? Scores a graph's experiment selections turn by turn, at a
 * cutoff, for a reference arm and the adaptive arm. No DB, no React.
 *
 * The contract with runtimes: an experiment named `adaptive-ranking:<source>`
 * with the arm `adaptive` (the catalog with the graph) and, usually, one
 * reference arm the customer chose:
 *
 * - `baseline`, the plain Ratel catalog, or
 * - `legacy`, the ranker Ratel is replacing, sending as many results as the
 *   customer cares to compare against (top-1, top-3, top-5).
 *
 * What counts as right on a turn, the target, is not a setting. It is the
 * invoked tool when the runtime reported one; else the reference arm's own
 * list, graded by rank (its first result is worth 1, its second 0.63, and so
 * on), so the score reads as agreement with that list. A turn whose target is
 * the reference list scores the adaptive arm only; the reference curve
 * averages the turns it was measured on independently.
 *
 * Turn order is the order Cloud stored the comparisons in. Online begins at
 * the first search the adaptive arm served (a shadow arm boosts without the
 * agent seeing it), else at the first boost a runtime reported from this
 * graph, else it is unknown.
 */

export const BOOST_EXPERIMENT_PREFIX = "adaptive-ranking:";
export const BOOST_BASELINE_ARM = "baseline";
export const BOOST_LEGACY_ARM = "legacy";
export const BOOST_TREATMENT_ARM = "adaptive";
/** Reference arms a runtime may pair with `adaptive`, in the order they are looked for. */
export const BOOST_REFERENCE_ARMS: readonly string[] = [BOOST_BASELINE_ARM, BOOST_LEGACY_ARM];
/** Cutoff every metric is taken at. Lists on the wire are this long. */
export const BOOST_K = 5;
/** Turns in the trailing window. */
export const BOOST_WINDOW = 50;
/**
 * First turn the chart draws. A running average over one or two turns is just
 * those turns' scores (100% or 0% for recall), so the curve would open on
 * noise; from here on each point averages enough turns to mean something.
 */
export const BOOST_MIN_TURNS = 10;

export function boostExperimentName(graphKey: string): string {
  return `${BOOST_EXPERIMENT_PREFIX}${graphKey}`;
}

export type BoostMetric = "recall@1" | "recall@3" | "recall@5" | "ndcg@5" | "mrr@5";

export const BOOST_METRICS: ReadonlyArray<{ id: BoostMetric; label: string; hint: string }> = [
  { id: "recall@1", label: "Recall@1", hint: "the target was the first result" },
  { id: "recall@3", label: "Recall@3", hint: "the target was in the top 3" },
  { id: "recall@5", label: "Recall@5", hint: "the target was in the list" },
  {
    id: "ndcg@5",
    label: "nDCG@5",
    hint: "rank credit, 1 at rank 1, 0.63 at rank 2, 0 when absent",
  },
  { id: "mrr@5", label: "MRR@5", hint: "mean reciprocal rank" },
];

/** The metric the panel opens on. */
export const BOOST_DEFAULT_METRIC: BoostMetric = "recall@1";

export type BoostArm = "reference" | "adaptive";

export type BoostPhase = "offline" | "online";

export type BoostReferenceKind = "baseline" | "legacy" | "none";

export interface BoostReference {
  /** The arm name the runtime used; null when no reference arm was sent. */
  arm: string | null;
  kind: BoostReferenceKind;
  /** Whether the reference curve is drawn: it is, on the turns whose target came from somewhere else. */
  scored: boolean;
  /** How deep the reference lists ran, at most the cutoff; null without a reference. */
  k: number | null;
}

/** Where the online period starts. */
export interface BoostOnline {
  since: Date | null;
  /** First turn at or after `since`; null when no drawn turn is online, or `since` is unknown. */
  fromTurn: number | null;
  source: "served" | "boost" | null;
}

/** One tool that counts as right on a turn, with how much it counts. */
export interface BoostTarget {
  id: string;
  /** 1 for the invoked tool or a reference's first result, falling by rank for the rest of a reference list. */
  gain: number;
}

export interface BoostTurn {
  /** 1-based position in the stored order. */
  turn: number;
  occurredAt: Date;
  /** `revealed`: the invoked tool. `reference`: the reference arm's own list. */
  tier: EvidenceTier;
  targets: BoostTarget[];
  /** Offline turns ran the reference arm only, or adaptive as a shadow; online turns adaptive served. */
  phase: BoostPhase;
  /** 1-based rank of the highest-gain target in each arm's list, or null when absent. */
  rank: Record<BoostArm, number | null>;
  /** Per metric, each arm's score on this turn; null where the arm is not measured on it. */
  score: Record<BoostMetric, Record<BoostArm, number | null>>;
  /** Whether the adaptive arm ran for this turn; offline turns often did not. */
  adaptiveRan: boolean;
}

/**
 * Running values per arm; null until the arm has been measured. When the
 * adaptive arm was absent offline, both averages restart at the online
 * boundary so any gap between the curves is a gap on the same turns. When
 * adaptive ran as a shadow offline, both cover every turn and the averages run
 * on through the switch.
 */
export interface BoostPoint {
  turn: number;
  /** How many turns the adaptive arm has been measured on by this point. */
  adaptiveTurns: number;
  cumulative: Record<BoostArm, number | null>;
  trailing: Record<BoostArm, number | null>;
}

/** Totals over the turns both arms were measured on, so the two are comparable. */
export interface BoostTotal {
  value: Record<BoostArm, number>;
  /**
   * Wilson interval on the share, for the recall metrics, and only when the
   * total is a share: every turn scored on the tool the agent used (0 or 1).
   * A reference-tier turn is graded by rank (1, 0.63, ...), and a mean of
   * grades is not a proportion, so a total with any graded turn carries none.
   */
  interval: Record<BoostArm, ConfidenceInterval | null>;
  /** Turns the totals cover. */
  turns: number;
}

/** Each arm's score in a phase, over the turns it was measured on: the before-and-after reading. */
export interface BoostPhaseTotal {
  turns: number;
  reference: number;
  adaptive: number;
  /** Turns in the phase both arms were measured on, and the nDCG verdict over them. */
  compared: number;
  verdict: { better: number; worse: number; same: number };
}

export interface BoostView {
  empty: boolean;
  /** True when some rankings are Cloud's own lexical replay, not what a runtime reported. */
  estimated: boolean;
  /** True when some rankings are the runtime's own, with and without the graph (`base_hits`). */
  reported: boolean;
  k: number;
  window: number;
  reference: BoostReference;
  online: BoostOnline;
  turns: BoostTurn[];
  series: Record<BoostMetric, BoostPoint[]>;
  totals: Record<BoostMetric, BoostTotal>;
  phases: Record<BoostMetric, Record<BoostPhase, BoostPhaseTotal>>;
  /** Per-turn verdict on nDCG over the turns both arms were measured on. */
  verdict: { better: number; worse: number; same: number };
  evidence: {
    /** Turns scored on the invoked tool. */
    revealed: number;
    /** Turns scored on the reference arm's own list. */
    reference: number;
    /** Selections dropped: an arm missing, or no target under either tier. */
    skipped: number;
    servingArm: string | null;
    bias: Record<BoostArm, RevealedBias>;
  };
}

/* — scoring —————————————————————————————————————————————————————————————— */

const RECALL_METRICS: ReadonlySet<BoostMetric> = new Set(["recall@1", "recall@3", "recall@5"]);

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Score one ranked list against graded targets at the cutoff. With a single
 * target of gain 1 these are the usual recall, nDCG and reciprocal rank of
 * its position. With a graded list, recall is the share of target gain found
 * within the cutoff, nDCG is the usual graded form, and MRR is the reciprocal
 * rank of the first target found.
 */
export function scoreList(
  metric: BoostMetric,
  list: readonly string[],
  targets: readonly BoostTarget[],
  k: number = BOOST_K,
): number {
  if (targets.length === 0) return 0;
  const gain = new Map(targets.map((t) => [t.id, t.gain]));
  const top = list.slice(0, k);
  const totalGain = targets.reduce((s, t) => s + t.gain, 0);
  const within = (n: number) =>
    top.slice(0, n).reduce((s, id) => s + (gain.get(id) ?? 0), 0) / totalGain;
  switch (metric) {
    case "recall@1":
      return within(1);
    case "recall@3":
      return within(3);
    case "recall@5":
      return within(k);
    case "ndcg@5": {
      const dcg = top.reduce((s, id, i) => s + (gain.get(id) ?? 0) / Math.log2(i + 2), 0);
      const ideal = [...targets]
        .map((t) => t.gain)
        .sort((a, b) => b - a)
        .slice(0, k)
        .reduce((s, g, i) => s + g / Math.log2(i + 2), 0);
      return ideal === 0 ? 0 : dcg / ideal;
    }
    case "mrr@5": {
      const index = top.findIndex((id) => gain.has(id));
      return index < 0 ? 0 : 1 / (index + 1);
    }
  }
}

/** Score one rank under a metric at the cutoff; absent or beyond the cutoff is 0. Single target of gain 1. */
export function metricValue(metric: BoostMetric, rank: number | null, k: number = BOOST_K): number {
  if (rank === null || rank > k) return 0;
  const list = Array.from({ length: rank }, (_, i) => (i + 1 === rank ? "t" : `x${i}`));
  return scoreList(metric, list, [{ id: "t", gain: 1 }], k);
}

/** A reference list as graded targets: rank credit falls with position, first result worth 1. */
export function referenceTargets(list: readonly string[], k: number = BOOST_K): BoostTarget[] {
  return list.slice(0, k).map((id, i) => ({ id, gain: rankCredit(i + 1) }));
}

/* — turns ————————————————————————————————————————————————————————————————— */

/** The reference arm the selections carry: the first known name found, or null. */
export function detectReferenceArm(selections: readonly EvaluableSelection[]): string | null {
  for (const selection of selections) {
    for (const name of BOOST_REFERENCE_ARMS) {
      if (selection.arms.some((arm) => arm.arm === name)) return name;
    }
  }
  return null;
}

function referenceKind(arm: string | null): BoostReferenceKind {
  if (arm === null) return "none";
  return arm === BOOST_LEGACY_ARM ? "legacy" : "baseline";
}

/**
 * When online began. The first search the adaptive arm served wins: a shadow
 * arm ranks and boosts without the agent seeing it, so a boost alone does not
 * make a turn online when the records can tell the roles apart.
 */
export function onlineBoundary(
  selections: readonly EvaluableSelection[],
  treatmentArm: string,
  onlineSince: Date | null,
): { since: Date | null; source: BoostOnline["source"] } {
  const served = selections.find((s) =>
    s.arms.some((a) => a.arm === treatmentArm && a.role === "serving"),
  );
  if (served) return { since: served.occurredAt, source: "served" };
  if (onlineSince !== null) return { since: onlineSince, source: "boost" };
  return { since: null, source: null };
}

const ALL_METRICS = BOOST_METRICS.map((m) => m.id);

/**
 * Fold selections into scored turns. The target is the invoked tool when one
 * was reported, else the reference list graded by rank; a turn with neither
 * is skipped, as is one missing the reference arm, or missing the adaptive
 * arm online. When the records can tell the roles apart (some turn has a
 * served adaptive arm), a turn's phase is its own: online when the adaptive
 * arm served it, offline when it only shadowed, so a turn after the graph was
 * released is offline again rather than online by the clock. Records that
 * only carry a boost time are dated by the boundary. An offline turn may lack
 * the adaptive arm; it is kept, scored on the reference alone.
 */
export function boostTurns(
  selections: readonly EvaluableSelection[],
  referenceArm: string | null = BOOST_BASELINE_ARM,
  treatmentArm: string = BOOST_TREATMENT_ARM,
  onlineSince: Date | null = null,
  k: number = BOOST_K,
): { turns: BoostTurn[]; skipped: number } {
  const online = onlineBoundary(selections, treatmentArm, onlineSince);
  const boundary = online.since;
  const turns: BoostTurn[] = [];
  let skipped = 0;
  for (const selection of selections) {
    const reference =
      referenceArm === null ? undefined : selection.arms.find((arm) => arm.arm === referenceArm);
    const adaptive = selection.arms.find((arm) => arm.arm === treatmentArm);
    // Records that can tell the roles apart (a served adaptive arm exists)
    // date each turn by its own role; a boost time alone dates them by the clock.
    const phase: BoostPhase =
      online.source === "served"
        ? adaptive?.role === "serving"
          ? "online"
          : "offline"
        : boundary !== null && selection.occurredAt.getTime() < boundary.getTime()
          ? "offline"
          : "online";
    const revealed = revealedTarget(selection);
    const targets: BoostTarget[] =
      revealed !== null
        ? [{ id: revealed, gain: 1 }]
        : reference && reference.resultIds.length > 0
          ? referenceTargets(reference.resultIds, k)
          : [];
    const referenceMissing = referenceArm !== null && !reference;
    const adaptiveMissing = !adaptive && (phase === "online" || referenceArm === null);
    if (referenceMissing || adaptiveMissing || targets.length === 0) {
      skipped += 1;
      continue;
    }
    const tier: EvidenceTier = revealed !== null ? "revealed" : "reference";
    // The reference arm is not measured against its own list.
    const referenceMeasured = reference !== undefined && tier === "revealed";
    const top = targets[0]!.id;
    const score = Object.fromEntries(
      ALL_METRICS.map((m) => [
        m,
        {
          reference: referenceMeasured ? scoreList(m, reference.resultIds, targets, k) : null,
          adaptive: adaptive ? scoreList(m, adaptive.resultIds, targets, k) : null,
        },
      ]),
    ) as BoostTurn["score"];
    turns.push({
      turn: turns.length + 1,
      occurredAt: selection.occurredAt,
      tier,
      targets,
      phase,
      rank: {
        reference: reference ? rankOf(reference.resultIds, top) : null,
        adaptive: adaptive ? rankOf(adaptive.resultIds, top) : null,
      },
      score,
      adaptiveRan: adaptive !== undefined,
    });
  }
  return { turns, skipped };
}

/** The first turn at or after `since`, in stored order. */
export function onlineFromTurn(turns: readonly BoostTurn[], since: Date | null): number | null {
  if (since === null) return null;
  const first = turns.find((t) => t.occurredAt.getTime() >= since.getTime());
  return first ? first.turn : null;
}

/* — series and totals ————————————————————————————————————————————————————— */

function seriesFor(metric: BoostMetric, turns: readonly BoostTurn[], window: number): BoostPoint[] {
  const running = { reference: 0, referenceTurns: 0, adaptive: 0, adaptiveTurns: 0 };
  return turns.map((t, i) => {
    const previous = turns[i - 1];
    if (i > 0 && t.phase === "online" && previous?.phase === "offline" && !previous.adaptiveRan) {
      running.reference = 0;
      running.referenceTurns = 0;
    }
    const v = t.score[metric];
    if (v.reference !== null) {
      running.reference += v.reference;
      running.referenceTurns += 1;
    }
    if (v.adaptive !== null) {
      running.adaptive += v.adaptive;
      running.adaptiveTurns += 1;
    }
    const slice = turns.slice(Math.max(0, i + 1 - window), i + 1).map((s) => s.score[metric]);
    const trailingOf = (arm: BoostArm) => {
      const values = slice.map((s) => s[arm]).filter((x): x is number => x !== null);
      return values.length === 0 ? null : mean(values);
    };
    return {
      turn: i + 1,
      adaptiveTurns: running.adaptiveTurns,
      cumulative: {
        reference: running.referenceTurns === 0 ? null : running.reference / running.referenceTurns,
        adaptive: running.adaptiveTurns === 0 ? null : running.adaptive / running.adaptiveTurns,
      },
      trailing: { reference: trailingOf("reference"), adaptive: trailingOf("adaptive") },
    };
  });
}

/** Turns both arms were measured on. */
function comparable(turns: readonly BoostTurn[]): BoostTurn[] {
  return turns.filter(
    (t) => t.score["ndcg@5"].reference !== null && t.score["ndcg@5"].adaptive !== null,
  );
}

/** Per-turn nDCG verdict over the turns both arms were measured on. */
function ndcgVerdict(turns: readonly BoostTurn[]): { better: number; worse: number; same: number } {
  const verdict = { better: 0, worse: 0, same: 0 };
  for (const t of comparable(turns)) {
    const b = t.score["ndcg@5"].reference ?? 0;
    const a = t.score["ndcg@5"].adaptive ?? 0;
    if (a > b + 1e-12) verdict.better += 1;
    else if (a < b - 1e-12) verdict.worse += 1;
    else verdict.same += 1;
  }
  return verdict;
}

function totalFor(metric: BoostMetric, allTurns: readonly BoostTurn[]): BoostTotal {
  const both = comparable(allTurns);
  // Without a measured reference the adaptive total covers every turn it ran.
  const turns = both.length > 0 ? both : allTurns.filter((t) => t.score[metric].adaptive !== null);
  const n = turns.length;
  const score = (arm: BoostArm) => {
    const values = turns.map((t) => t.score[metric][arm]).filter((x): x is number => x !== null);
    const value = mean(values);
    const binary = values.every((v) => v === 0 || v === 1);
    const interval =
      RECALL_METRICS.has(metric) && values.length > 0 && binary
        ? wilsonInterval(values.filter((v) => v === 1).length, values.length)
        : null;
    return { value, interval };
  };
  const reference = score("reference");
  const adaptive = score("adaptive");
  return {
    value: { reference: reference.value, adaptive: adaptive.value },
    interval: { reference: reference.interval, adaptive: adaptive.interval },
    turns: n,
  };
}

function phaseTotals(
  metric: BoostMetric,
  turns: readonly BoostTurn[],
): Record<BoostPhase, BoostPhaseTotal> {
  const of = (phase: BoostPhase): BoostPhaseTotal => {
    const inPhase = turns.filter((t) => t.phase === phase);
    const values = (arm: BoostArm) =>
      inPhase.map((t) => t.score[metric][arm]).filter((x): x is number => x !== null);
    return {
      turns: inPhase.length,
      reference: mean(values("reference")),
      adaptive: mean(values("adaptive")),
      compared: comparable(inPhase).length,
      verdict: ndcgVerdict(inPhase),
    };
  };
  return { offline: of("offline"), online: of("online") };
}

const EMPTY_SERIES = (): Record<BoostMetric, BoostPoint[]> => ({
  "recall@1": [],
  "recall@3": [],
  "recall@5": [],
  "ndcg@5": [],
  "mrr@5": [],
});
const EMPTY_TOTALS = () =>
  Object.fromEntries(
    BOOST_METRICS.map((m) => [
      m.id,
      {
        value: { reference: 0, adaptive: 0 },
        interval: { reference: null, adaptive: null },
        turns: 0,
      },
    ]),
  ) as Record<BoostMetric, BoostTotal>;
const EMPTY_PHASES = () =>
  Object.fromEntries(
    BOOST_METRICS.map((m) => [
      m.id,
      {
        offline: {
          turns: 0,
          reference: 0,
          adaptive: 0,
          compared: 0,
          verdict: { better: 0, worse: 0, same: 0 },
        },
        online: {
          turns: 0,
          reference: 0,
          adaptive: 0,
          compared: 0,
          verdict: { better: 0, worse: 0, same: 0 },
        },
      },
    ]),
  ) as Record<BoostMetric, Record<BoostPhase, BoostPhaseTotal>>;

export function buildBoostView(
  selections: readonly EvaluableSelection[],
  options: {
    /** Overrides detection; `baselineArm` is the older spelling of the same thing. */
    referenceArm?: string | null;
    baselineArm?: string;
    treatmentArm?: string;
    k?: number;
    window?: number;
    /** When runtimes started boosting from this graph, or null when unknown. */
    onlineSince?: Date | null;
    /** Some selections are Cloud's own replay of stored searches. */
    estimated?: boolean;
    /** Some selections are the runtime's own report of both rankings. */
    reported?: boolean;
  } = {},
): BoostView {
  const referenceArm =
    options.referenceArm !== undefined
      ? options.referenceArm
      : (options.baselineArm ?? detectReferenceArm(selections));
  const treatmentArm = options.treatmentArm ?? BOOST_TREATMENT_ARM;
  const k = options.k ?? BOOST_K;
  const window = options.window ?? BOOST_WINDOW;
  const boundary = onlineBoundary(selections, treatmentArm, options.onlineSince ?? null);
  const { turns, skipped } = boostTurns(
    selections,
    referenceArm,
    treatmentArm,
    options.onlineSince ?? null,
    k,
  );
  const online: BoostOnline = {
    since: boundary.since,
    fromTurn: onlineFromTurn(turns, boundary.since),
    source: boundary.source,
  };
  const revealed = turns.filter((t) => t.tier === "revealed").length;
  const referenceDepth =
    referenceArm === null
      ? null
      : Math.min(
          k,
          Math.max(
            0,
            ...selections.map(
              (s) => s.arms.find((a) => a.arm === referenceArm)?.resultIds.length ?? 0,
            ),
          ),
        );
  const reference: BoostReference = {
    arm: referenceArm,
    kind: referenceKind(referenceArm),
    scored: referenceArm !== null && revealed > 0,
    k: referenceDepth === 0 ? null : referenceDepth,
  };
  const servingArm =
    selections
      .map((s) => s.arms.find((a) => a.role === "serving")?.arm ?? null)
      .find((a) => a !== null) ?? null;
  const evidence = {
    revealed,
    reference: turns.filter((t) => t.tier === "reference").length,
    skipped,
    servingArm,
    bias: {
      reference:
        referenceArm === null
          ? ("independent" as const)
          : revealedArmBias(selections, referenceArm),
      adaptive: revealedArmBias(selections, treatmentArm),
    },
  };
  if (turns.length === 0) {
    return {
      empty: true,
      estimated: options.estimated ?? false,
      reported: options.reported ?? false,
      k,
      window,
      reference,
      online,
      turns,
      series: EMPTY_SERIES(),
      totals: EMPTY_TOTALS(),
      phases: EMPTY_PHASES(),
      verdict: { better: 0, worse: 0, same: 0 },
      evidence,
    };
  }
  const series = Object.fromEntries(
    BOOST_METRICS.map((m) => [m.id, seriesFor(m.id, turns, window)]),
  ) as Record<BoostMetric, BoostPoint[]>;
  const totals = Object.fromEntries(
    BOOST_METRICS.map((m) => [m.id, totalFor(m.id, turns)]),
  ) as Record<BoostMetric, BoostTotal>;
  const phases = Object.fromEntries(
    BOOST_METRICS.map((m) => [m.id, phaseTotals(m.id, turns)]),
  ) as Record<BoostMetric, Record<BoostPhase, BoostPhaseTotal>>;
  const verdict = ndcgVerdict(turns);
  return {
    empty: false,
    estimated: options.estimated ?? false,
    reported: options.reported ?? false,
    k,
    window,
    reference,
    online,
    turns,
    series,
    totals,
    phases,
    verdict,
    evidence,
  };
}
