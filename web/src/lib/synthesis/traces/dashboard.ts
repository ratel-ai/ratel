import type { Delta } from "@/lib/synthesis/dashboard";
import { halfDelta } from "@/lib/synthesis/dashboard";
import { formatCount, formatDuration, formatTokens } from "./format";
import type { TraceDailyAggregate, TraceKpis } from "./queries";

const TARGET_TRACE_VOLUME_BUCKETS = 60;
const TRACE_BUCKET_STEPS = [2, 3, 7, 14, 30] as const;

export type TraceKpiKey = "traces" | "errors" | "latency" | "tokens";

export interface TraceDashboardDay {
  day: string;
  label: string;
  traceCount: number;
  cleanTraceCount: number;
  errorTraceCount: number;
  errorRate: number;
  averageLatencyMs: number;
  totalTokens: number;
  costUsd: number;
}

export interface TraceKpiView {
  key: TraceKpiKey;
  label: string;
  value: string;
  sub: string;
  series: number[];
  delta: Delta | null;
  upIsGood: boolean;
}

export interface TraceVolumeBucket {
  fromDay: string;
  toDay: string;
  label: string;
  rangeLabel: string;
  traceCount: number;
  cleanTraceCount: number;
  errorTraceCount: number;
  averageLatencyMs: number;
  totalTokens: number;
  costUsd: number;
}

export interface TraceDashboardModel {
  days: TraceDashboardDay[];
  kpis: TraceKpiView[];
  buckets: TraceVolumeBucket[];
}

export function buildTraceDashboardModel(
  totals: TraceKpis,
  aggregates: readonly TraceDailyAggregate[],
  windowDays: readonly string[],
  now = new Date(),
): TraceDashboardModel {
  const byDay = new Map(aggregates.map((aggregate) => [aggregate.day, aggregate]));
  const days = windowDays.map((day): TraceDashboardDay => {
    const aggregate = byDay.get(day);
    const traceCount = aggregate?.traceCount ?? 0;
    const errorTraceCount = Math.min(traceCount, aggregate?.errorTraceCount ?? 0);

    return {
      day,
      label: dayLabel(day),
      traceCount,
      cleanTraceCount: traceCount - errorTraceCount,
      errorTraceCount,
      errorRate: traceCount === 0 ? 0 : errorTraceCount / traceCount,
      averageLatencyMs: aggregate?.averageLatencyMs ?? 0,
      totalTokens: aggregate?.totalTokens ?? 0,
      costUsd: aggregate?.costUsd ?? 0,
    };
  });
  const currentUtcDay = now.toISOString().slice(0, 10);
  const completedDays = days.filter(({ day }) => day < currentUtcDay);

  return {
    days,
    kpis: buildTraceKpis(totals, days, completedDays),
    buckets: bucketTraceVolume(days),
  };
}

function buildTraceKpis(
  totals: TraceKpis,
  days: readonly TraceDashboardDay[],
  completedDays: readonly TraceDashboardDay[],
): TraceKpiView[] {
  const traceSeries = days.map(({ traceCount }) => traceCount);
  const errorSeries = days.map(({ errorRate }) => errorRate);
  const latencySeries = days.map(({ averageLatencyMs }) => averageLatencyMs);
  const tokenSeries = days.map(({ totalTokens }) => totalTokens);
  const completedTraceSeries = completedDays.map(({ traceCount }) => traceCount);
  const completedTokenSeries = completedDays.map(({ totalTokens }) => totalTokens);
  const cleanTraceCount = Math.max(0, totals.traceCount - totals.errorTraceCount);

  return [
    {
      key: "traces",
      label: "Traces",
      value: formatCount(totals.traceCount),
      sub: `${formatCount(cleanTraceCount)} clean`,
      series: traceSeries,
      delta: halfDelta(completedTraceSeries),
      upIsGood: true,
    },
    {
      key: "errors",
      label: "Error rate",
      value: formatPercent(totals.errorRate),
      sub: `${formatCount(totals.errorTraceCount)} affected trace${
        totals.errorTraceCount === 1 ? "" : "s"
      }`,
      series: errorSeries,
      delta: halfWeightedDelta(
        completedDays,
        ({ errorTraceCount }) => errorTraceCount,
        ({ traceCount }) => traceCount,
      ),
      upIsGood: false,
    },
    {
      key: "latency",
      label: "Avg latency",
      value: formatDuration(totals.averageLatencyMs ?? Number.NaN),
      sub: `p95 ${formatDuration(totals.p95LatencyMs ?? Number.NaN)}`,
      series: latencySeries,
      delta: halfWeightedDelta(
        completedDays,
        ({ averageLatencyMs, traceCount }) => averageLatencyMs * traceCount,
        ({ traceCount }) => traceCount,
      ),
      upIsGood: false,
    },
    {
      key: "tokens",
      label: "Tokens",
      value: formatTokens(totals.totalTokens),
      sub: `${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out`,
      series: tokenSeries,
      delta: halfDelta(completedTokenSeries),
      upIsGood: false,
    },
  ];
}

function bucketTraceVolume(days: readonly TraceDashboardDay[]): TraceVolumeBucket[] {
  const step = traceBucketSize(days.length);
  const buckets: TraceVolumeBucket[] = [];

  for (let index = 0; index < days.length; index += step) {
    const group = days.slice(index, index + step);
    const first = group[0];
    const last = group.at(-1);
    if (!first || !last) continue;
    const traceCount = sumBy(group, ({ traceCount: value }) => value);
    const latencyTotal = sumBy(
      group,
      ({ averageLatencyMs, traceCount: value }) => averageLatencyMs * value,
    );

    buckets.push({
      fromDay: first.day,
      toDay: last.day,
      label: last.label,
      rangeLabel: first.day === last.day ? first.label : `${first.label} – ${last.label}`,
      traceCount,
      cleanTraceCount: sumBy(group, ({ cleanTraceCount }) => cleanTraceCount),
      errorTraceCount: sumBy(group, ({ errorTraceCount }) => errorTraceCount),
      averageLatencyMs: traceCount === 0 ? 0 : latencyTotal / traceCount,
      totalTokens: sumBy(group, ({ totalTokens }) => totalTokens),
      costUsd: sumBy(group, ({ costUsd }) => costUsd),
    });
  }

  return buckets;
}

function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function halfWeightedDelta<T>(
  values: readonly T[],
  numerator: (value: T) => number,
  denominator: (value: T) => number,
): Delta | null {
  if (values.length < 4) return null;
  const halfLength = Math.floor(values.length / 2);
  const earlier = weightedValue(values.slice(0, halfLength), numerator, denominator);
  const recent = weightedValue(values.slice(values.length - halfLength), numerator, denominator);
  if (earlier === null || recent === null || earlier <= 0) return null;
  const pct = (recent - earlier) / earlier;
  return {
    pct,
    dir: pct > 0.005 ? "up" : pct < -0.005 ? "down" : "flat",
  };
}

function traceBucketSize(dayCount: number): number {
  if (dayCount <= TARGET_TRACE_VOLUME_BUCKETS) return 1;
  return (
    TRACE_BUCKET_STEPS.find((step) => Math.ceil(dayCount / step) <= TARGET_TRACE_VOLUME_BUCKETS) ??
    Math.ceil(dayCount / TARGET_TRACE_VOLUME_BUCKETS)
  );
}

function sumBy<T>(values: readonly T[], select: (value: T) => number): number {
  return values.reduce((total, value) => total + select(value), 0);
}

function weightedValue<T>(
  values: readonly T[],
  numerator: (value: T) => number,
  denominator: (value: T) => number,
): number | null {
  const weight = sumBy(values, denominator);
  return weight <= 0 ? null : sumBy(values, numerator) / weight;
}
