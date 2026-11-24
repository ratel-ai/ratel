import { niceCeil } from "@/lib/platform/chart";
import type { MetricAggregation, MetricUnit } from "@/lib/synthesis/metrics/catalog";
import type { MetricResult } from "@/lib/synthesis/metrics/query";
import {
  formatCompact,
  formatDay,
  formatDuration,
  formatInteger,
  formatMoney,
  formatPercent,
  MISSING,
} from "@/lib/synthesis/traces/v2/format";

/** What a widget draws, from its metric result. Pure, so the charts only place marks. */

/** Series with a color of their own (DESIGN.md, Data visualization: six slots, never cycled). */
export const CHART_SLOTS = 6;

/** The top of a scorer's 1 to 5 scale. */
const SCORE_MAX = 5;

export interface ChartSeries {
  /** The group's value: what its color and key follow. */
  key: string;
  label: string;
  /** 1 to 6, or null for "Other". */
  slot: number | null;
  values: (number | null)[];
}

export interface ChartModel {
  series: ChartSeries[];
  scaleMax: number;
  /** Stacked: the groups add up to a whole. */
  stacked: boolean;
  /** What is left out of the drawing, or null. */
  note: string | null;
}

/** Nothing behind the widget in this window. */
export function isEmptyResult(result: MetricResult): boolean {
  return result.series.every((series) => series.samples === 0);
}

export function chartModel(
  result: MetricResult,
  aggregation: MetricAggregation,
  unit: MetricUnit,
  chart: "line" | "bar",
): ChartModel {
  const additive = aggregation === "count" || aggregation === "sum";
  const shown = result.series.slice(0, CHART_SLOTS);
  const rest = result.series.slice(CHART_SLOTS);
  // Slots go by name, so a group keeps its color when the ranking moves.
  const order = shown.map((series) => series.group ?? "").sort();
  const series: ChartSeries[] = shown.map(({ group, label, values }) => ({
    key: group ?? "",
    label: label ?? group ?? "",
    slot: order.indexOf(group ?? "") + 1,
    values,
  }));
  if (rest.length > 0 && additive) {
    series.push({
      key: "\u0000other",
      label: "Other",
      slot: null,
      values: result.buckets.map((_, index) =>
        rest.reduce((sum, { values }) => sum + (values[index] ?? 0), 0),
      ),
    });
  }
  const stacked = chart === "bar" && additive && series.length > 1;
  const peak = result.buckets.reduce((max, _, index) => {
    const at = series.map(({ values }) => values[index] ?? 0);
    return Math.max(max, stacked ? at.reduce((sum, value) => sum + value, 0) : Math.max(0, ...at));
  }, 0);
  const scaleMax = niceCeil(peak);
  return {
    series,
    scaleMax: unit === "ratio" ? Math.min(1, scaleMax) : unit === "score" ? SCORE_MAX : scaleMax,
    stacked,
    note:
      rest.length > 0 && !additive
        ? `The ${CHART_SLOTS} highest of ${result.series.length} groups. A table shows them all.`
        : null,
  };
}

/** Abbreviated, for a stat, an axis and a readout. */
export function formatMetric(value: number | null, unit: MetricUnit): string {
  if (unit === "usd") return formatMoney(value);
  if (unit === "ms") return formatDuration(value);
  if (unit === "ratio") return formatPercent(value);
  if (unit === "score") return value === null ? MISSING : trimmedScore(value);
  return formatCompact(value);
}

/** A 1 to 5 average, with two decimals at most. */
function trimmedScore(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Exact, for a table. */
export function formatMetricExact(value: number | null, unit: MetricUnit): string {
  return unit === "count" || unit === "tokens" ? formatInteger(value) : formatMetric(value, unit);
}

/** "Oct 9", or "Oct 9, 14:00" for an hour. */
export function bucketName(start: string, bucket: MetricResult["bucket"]): string {
  const day = formatDay(start.slice(0, 10));
  return bucket === "hour" ? `${day}, ${start.slice(11, 16)} UTC` : day;
}

/** Recessive axis labels, at most `target`: hours within a day, days otherwise. */
export function axisTicks(
  buckets: readonly string[],
  bucket: MetricResult["bucket"],
  target: number,
): { index: number; label: string }[] {
  const oneDay = new Set(buckets.map((start) => start.slice(0, 10))).size === 1;
  const candidates = buckets.flatMap((start, index) => {
    if (bucket === "hour" && oneDay) return [{ index, label: start.slice(11, 16) }];
    return bucket === "day" || start.slice(11, 13) === "00"
      ? [{ index, label: formatDay(start.slice(0, 10)) }]
      : [];
  });
  const every = Math.max(1, Math.ceil(candidates.length / Math.max(1, target)));
  return candidates.filter((_, position) => position % every === 0);
}

/** Runs of consecutive values, so a line breaks where there is nothing to read. */
export function lineSegments(values: readonly (number | null)[]): number[][] {
  const segments: number[][] = [];
  let current: number[] = [];
  for (const [index, value] of values.entries()) {
    if (value !== null) current.push(index);
    else if (current.length > 0) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}
