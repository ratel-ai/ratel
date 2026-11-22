import { wilsonInterval } from "@/lib/readings/stats";
import { bootstrapInterval, percentile } from "./bootstrap";

/**
 * How each variant of one experiment does (RC-870): pure, no I/O. The store
 * reads one experiment's traces in a window and hands each variant's counts and
 * sampled traces here; this turns them into rates and figures with 95%
 * intervals, picks the baseline, flags a variant under the minimum sample and
 * decides the "cheaper model" suggestion.
 *
 * Rates (errors, health signals, scorer passes) use Wilson intervals. Latency
 * percentiles and cost per successful trace use a seeded bootstrap over the
 * sampled traces, so the same traces always give the same interval.
 */

/** Below this many runs a variant shows a warning and gets no suggestion. */
export const MIN_VARIANT_RUNS = 30;

/** Variant names read as the baseline, in this order, before the one with the most runs. */
export const BASELINE_NAMES = ["baseline", "control"] as const;

/** Per-trace facts the health signals read (`trace_turns`), lower is better. */
export const HEALTH_KINDS = ["tool_errors", "self_corrections", "abandoned", "detours"] as const;
export type HealthKind = (typeof HEALTH_KINDS)[number];

export interface Interval {
  low: number;
  high: number;
}

export interface Rate {
  value: number;
  interval: Interval;
  /** The traces the rate is measured on. */
  n: number;
}

export interface Estimate {
  value: number;
  interval: Interval;
}

/** One sampled trace of a variant. */
export interface SampledTrace {
  durationMs: number;
  costUsd: number;
  hasError: boolean;
}

/** What the store reads for one variant. */
export interface VariantSample {
  name: string;
  /** The `ratel.variant.*` descriptors of its newest trace (`model`, `prompt_version`). */
  attrs: Record<string, unknown>;
  /** Every trace in the window. */
  runs: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  /** The newest traces, at most the store's sample bound. */
  traces: readonly SampledTrace[];
  /** Per health kind: the sampled traces it was measured on and how many showed it. */
  health: Partial<Record<HealthKind, { n: number; hits: number }>>;
  /** The task scorers over the sampled traces; null when none was scored. */
  scorer: { n: number; passed: number } | null;
}

export interface VariantMetrics {
  name: string;
  attrs: Record<string, unknown>;
  isBaseline: boolean;
  runs: number;
  /** The traces the latency and cost figures are read from. */
  sampled: number;
  errorRate: Rate | null;
  latencyP50Ms: Estimate | null;
  latencyP95Ms: Estimate | null;
  tokens: { input: number; output: number; perRun: number | null };
  costPerSuccessUsd: Estimate | null;
  health: { kind: HealthKind; rate: Rate }[];
  scorerPassRate: Rate | null;
  belowMinimumSample: boolean;
  warning: string | null;
}

export type BaselineReason = "named" | "most_runs";

export interface CheaperSuggestion {
  kind: "cheaper_model";
  variant: string;
  baseline: string;
  costPerSuccessUsd: number;
  baselineCostPerSuccessUsd: number;
  /** 1 - variant / baseline cost per successful trace. */
  savingsFraction: number;
  /** The quality figures the rule held: always the error rate, and the scorer pass rate when both have one. */
  qualityBasis: ("error_rate" | "scorer_pass_rate")[];
}

export interface VariantComparison {
  experiment: string;
  baseline: { name: string; reason: BaselineReason } | null;
  minimumSample: number;
  variants: VariantMetrics[];
  suggestions: CheaperSuggestion[];
}

/** Every variant's metrics, the baseline and the suggestions. `seed` fixes the bootstrap. */
export function compareVariants(
  experiment: string,
  samples: readonly VariantSample[],
  seed = experiment,
): VariantComparison {
  const baseline = pickBaseline(samples);
  const variants = samples.map((sample) =>
    variantMetrics(sample, sample.name === baseline?.name, `${seed}:${sample.name}`),
  );
  const base = variants.find((variant) => variant.isBaseline) ?? null;
  const suggestions = base
    ? variants
        .filter((variant) => !variant.isBaseline)
        .flatMap((variant) => cheaperSuggestion(variant, base) ?? [])
    : [];
  return { experiment, baseline, minimumSample: MIN_VARIANT_RUNS, variants, suggestions };
}

/** The variant named `baseline` or `control`, else the one with the most runs (ties: by name). */
export function pickBaseline(
  samples: readonly Pick<VariantSample, "name" | "runs">[],
): { name: string; reason: BaselineReason } | null {
  for (const name of BASELINE_NAMES) {
    const named = samples.find((sample) => sample.name.trim().toLowerCase() === name);
    if (named) return { name: named.name, reason: "named" };
  }
  const [top] = [...samples].sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
  return top ? { name: top.name, reason: "most_runs" } : null;
}

/** One variant's figures with intervals. */
export function variantMetrics(
  sample: VariantSample,
  isBaseline: boolean,
  seed: string,
): VariantMetrics {
  const belowMinimumSample = sample.runs < MIN_VARIANT_RUNS;
  const durations = sample.traces.map((trace) => trace.durationMs);
  return {
    name: sample.name,
    attrs: sample.attrs,
    isBaseline,
    runs: sample.runs,
    sampled: sample.traces.length,
    errorRate: rate(sample.errors, sample.runs),
    latencyP50Ms: percentileEstimate(durations, 0.5, `${seed}:p50`),
    latencyP95Ms: percentileEstimate(durations, 0.95, `${seed}:p95`),
    tokens: {
      input: sample.inputTokens,
      output: sample.outputTokens,
      perRun: sample.runs > 0 ? (sample.inputTokens + sample.outputTokens) / sample.runs : null,
    },
    costPerSuccessUsd: costPerSuccessEstimate(sample.traces, `${seed}:cost`),
    health: HEALTH_KINDS.flatMap((kind) => {
      const measured = sample.health[kind];
      const value = measured ? rate(measured.hits, measured.n) : null;
      return value ? [{ kind, rate: value }] : [];
    }),
    scorerPassRate: sample.scorer ? rate(sample.scorer.passed, sample.scorer.n) : null,
    belowMinimumSample,
    warning: belowMinimumSample
      ? `${sample.runs} ${sample.runs === 1 ? "run" : "runs"}, under the ${MIN_VARIANT_RUNS} needed to compare: read these figures as early.`
      : null,
  };
}

/**
 * The "cheaper model" rule: the variant costs less per successful trace than the
 * baseline, both pass the minimum sample, and its quality stays inside the
 * baseline's interval: its error rate is at most the baseline's upper bound and,
 * when both were scored, its scorer pass rate is at least the baseline's lower
 * bound. Better quality never blocks it.
 */
export function cheaperSuggestion(
  variant: VariantMetrics,
  baseline: VariantMetrics,
): CheaperSuggestion | null {
  if (variant.belowMinimumSample || baseline.belowMinimumSample) return null;
  const cost = variant.costPerSuccessUsd?.value;
  const baseCost = baseline.costPerSuccessUsd?.value;
  if (cost == null || baseCost == null || !(cost < baseCost)) return null;
  if (!variant.errorRate || !baseline.errorRate) return null;
  if (variant.errorRate.value > baseline.errorRate.interval.high) return null;
  const qualityBasis: CheaperSuggestion["qualityBasis"] = ["error_rate"];
  if (baseline.scorerPassRate) {
    if (!variant.scorerPassRate) return null;
    if (variant.scorerPassRate.value < baseline.scorerPassRate.interval.low) return null;
    qualityBasis.push("scorer_pass_rate");
  }
  return {
    kind: "cheaper_model",
    variant: variant.name,
    baseline: baseline.name,
    costPerSuccessUsd: cost,
    baselineCostPerSuccessUsd: baseCost,
    savingsFraction: baseCost > 0 ? 1 - cost / baseCost : 0,
    qualityBasis,
  };
}

/** A proportion with its 95% Wilson interval; null without a measured trace. */
export function rate(successes: number, total: number): Rate | null {
  const interval = wilsonInterval(successes, total);
  return interval ? { value: successes / total, interval, n: total } : null;
}

function percentileEstimate(values: readonly number[], q: number, seed: string): Estimate | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    value: percentile(sorted, q),
    interval: bootstrapInterval(
      values,
      (sample) =>
        percentile(
          [...sample].sort((a, b) => a - b),
          q,
        ),
      seed,
    )!,
  };
}

/** Total cost of the sampled traces over their successful ones: a failed run's cost counts against the variant. */
function costPerSuccessEstimate(traces: readonly SampledTrace[], seed: string): Estimate | null {
  const value = costPerSuccess(traces);
  if (value === null) return null;
  return {
    value,
    interval: bootstrapInterval(traces, costPerSuccess, seed) ?? { low: value, high: value },
  };
}

function costPerSuccess(traces: readonly SampledTrace[]): number | null {
  let cost = 0;
  let successes = 0;
  for (const trace of traces) {
    cost += trace.costUsd;
    if (!trace.hasError) successes++;
  }
  return successes > 0 ? cost / successes : null;
}
