/**
 * The volume chart's model (DESIGN.md, Data visualization): runs per time
 * bucket, failures stacked on the shared baseline, thin bars with a 2 px gap
 * and 4 px rounded data ends.
 *
 * Buckets adapt to the window so the bars stay thin: a day reads by the hour,
 * a week by two hours, a quarter by the day. Selecting bars sets the window,
 * and the window lives in the URL as whole UTC days (`range=custom&from&to`),
 * the contract the v1 brush already wrote, so links keep working.
 */

import { niceCeil } from "@/lib/platform/chart";
import { DEFAULT_TRACE_RANGE } from "@/lib/synthesis/traces/view";
import { formatClock, formatDay, formatDayRange, NBSP } from "./format";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Most bars a window draws; the step grows until the count fits. */
export const MAX_VOLUME_BUCKETS = 100;
/** Hours per bucket, smallest first. */
const STEP_HOURS = [1, 2, 3, 6, 12, 24, 48, 72, 168, 336] as const;

/** Bar geometry (DESIGN.md, Marks): a 2 px surface gap, bars never thicker than 24 px. */
export const BAR_GAP = 2;
export const MAX_BAR_WIDTH = 24;
export const BAR_RADIUS = 4;
/** A bucket that failed must show it, however busy it was. */
export const MIN_ERROR_HEIGHT = 2;
/** A bucket with traffic is never drawn as nothing. */
export const MIN_BAR_HEIGHT = 2;

/** One row of the aggregate's volume: a UTC day, and an hour when hourly. */
export interface VolumePoint {
  day: string;
  hour?: number;
  count: number;
  errorCount: number;
}

export interface VolumeBucket {
  /** Inclusive start, UTC epoch ms. */
  startMs: number;
  /** Exclusive end, UTC epoch ms. */
  endMs: number;
  /** UTC days the bucket covers, inclusive: what selecting it filters to. */
  fromDay: string;
  toDay: string;
  count: number;
  errorCount: number;
}

export interface VolumeModel {
  buckets: VolumeBucket[];
  stepHours: number;
  /** The top gridline: the busiest bucket rounded up to a clean number. */
  scaleMax: number;
  totals: { count: number; errorCount: number };
}

/** Hours per bucket for a window of `dayCount` UTC days. */
export function volumeStepHours(dayCount: number): number {
  const hours = Math.max(1, dayCount) * 24;
  for (const step of STEP_HOURS) {
    if (Math.ceil(hours / step) <= MAX_VOLUME_BUCKETS) return step;
  }
  return STEP_HOURS[STEP_HOURS.length - 1];
}

/** Whether the window needs the aggregate's hourly volume. */
export function needsHourlyVolume(dayCount: number): boolean {
  return volumeStepHours(dayCount) < 24;
}

/**
 * Fold the aggregate's volume into the window's buckets. Points outside the
 * window are dropped. Daily points can't be split into hours, so a daily
 * series always draws daily buckets whatever the step asked for.
 */
export function buildVolumeModel({
  from,
  to,
  points,
  stepHours = volumeStepHours(dayCount(from, to)),
}: {
  from: string;
  to: string;
  points: readonly VolumePoint[];
  stepHours?: number;
}): VolumeModel {
  // An empty series has nothing to contradict the step it asked for.
  const hourly = points.every((point) => point.hour !== undefined);
  const step = !hourly && stepHours < 24 ? 24 : stepHours;
  const windowStart = dayMs(from);
  const windowEnd = dayMs(to) + DAY_MS;
  const stepMs = step * HOUR_MS;
  const count = Math.max(1, Math.ceil((windowEnd - windowStart) / stepMs));
  const buckets: VolumeBucket[] = Array.from({ length: count }, (_, index) => {
    const startMs = windowStart + index * stepMs;
    const endMs = Math.min(windowEnd, startMs + stepMs);
    return {
      startMs,
      endMs,
      fromDay: isoDay(startMs),
      toDay: isoDay(endMs - 1),
      count: 0,
      errorCount: 0,
    };
  });
  for (const point of points) {
    const at = dayMs(point.day) + (point.hour ?? 0) * HOUR_MS;
    if (!Number.isFinite(at) || at < windowStart || at >= windowEnd) continue;
    const bucket = buckets[Math.floor((at - windowStart) / stepMs)];
    if (!bucket) continue;
    bucket.count += Math.max(0, point.count);
    bucket.errorCount += Math.max(0, Math.min(point.errorCount, point.count));
  }
  const peak = buckets.reduce((max, bucket) => Math.max(max, bucket.count), 0);
  return {
    buckets,
    stepHours: step,
    scaleMax: niceCeil(peak),
    totals: buckets.reduce(
      (sum, bucket) => ({
        count: sum.count + bucket.count,
        errorCount: sum.errorCount + bucket.errorCount,
      }),
      { count: 0, errorCount: 0 },
    ),
  };
}

/** The UTC days a selection of buckets covers, inclusive. */
export function selectionDays(
  buckets: readonly VolumeBucket[],
  [first, last]: readonly [number, number],
): { from: string; to: string } | null {
  const start = buckets[Math.min(first, last)];
  const end = buckets[Math.max(first, last)];
  return start && end ? { from: start.fromDay, to: end.toDay } : null;
}

/**
 * Whether selecting bars can narrow the window at all. The URL keeps whole
 * UTC days, so a window of one day (Today, say) has nothing narrower to offer.
 */
export function canSelectDays(buckets: readonly VolumeBucket[]): boolean {
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  return Boolean(first && last && first.fromDay !== last.toDay);
}

/** The days a selection would show, or null when that is the whole window already and nothing would change. */
export function selectionWindow(
  buckets: readonly VolumeBucket[],
  range: readonly [number, number],
): { from: string; to: string } | null {
  const days = selectionDays(buckets, range);
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  if (!days || !first || !last) return null;
  return days.from === first.fromDay && days.to === last.toDay ? null : days;
}

export function selectionTotals(
  buckets: readonly VolumeBucket[],
  [first, last]: readonly [number, number],
): { count: number; errorCount: number } {
  return buckets.slice(Math.min(first, last), Math.max(first, last) + 1).reduce(
    (sum, bucket) => ({
      count: sum.count + bucket.count,
      errorCount: sum.errorCount + bucket.errorCount,
    }),
    { count: 0, errorCount: 0 },
  );
}

/**
 * The query string after selecting a range of days: the v1 brush's contract
 * (`range=custom&from&to`), with the cursor and the open row dropped because
 * neither survives a new window.
 */
export function withSelectedDays(search: string, days: { from: string; to: string }): string {
  const params = new URLSearchParams(search.replace(/^\?/, ""));
  params.set("range", "custom");
  params.set("from", days.from);
  params.set("to", days.to);
  params.delete("cursor");
  params.delete("peek");
  return query(params);
}

/** Back to the default window after a zoom. */
export function withDefaultRange(search: string): string {
  const params = new URLSearchParams(search.replace(/^\?/, ""));
  params.set("range", DEFAULT_TRACE_RANGE);
  params.delete("from");
  params.delete("to");
  params.delete("cursor");
  params.delete("peek");
  return query(params);
}

export interface BarLayout {
  slot: number;
  barWidth: number;
  /** Left edge of bar `index`, centred in its slot. */
  x: (index: number) => number;
}

/** Bars fill their slot less a 2 px gap, never wider than 24 px; the rest is air. */
export function barLayout(width: number, count: number): BarLayout {
  if (width <= 0 || count <= 0) return { slot: 0, barWidth: 0, x: () => 0 };
  const slot = width / count;
  const barWidth = Math.max(1, Math.min(MAX_BAR_WIDTH, slot - BAR_GAP));
  const inset = (slot - barWidth) / 2;
  return { slot, barWidth, x: (index) => index * slot + inset };
}

/**
 * Segment heights for one bucket on a plot `plotHeight` px tall. Failures sit
 * on the baseline so they compare across bars; completed runs stack above
 * them after the 2 px surface gap. Both carry a legibility floor.
 */
export function stackHeights(
  bucket: Pick<VolumeBucket, "count" | "errorCount">,
  scaleMax: number,
  plotHeight: number,
): { error: number; ok: number; gap: number } {
  if (bucket.count <= 0 || scaleMax <= 0) return { error: 0, ok: 0, gap: 0 };
  const total = Math.max(MIN_BAR_HEIGHT, (bucket.count / scaleMax) * plotHeight);
  const okCount = bucket.count - bucket.errorCount;
  if (bucket.errorCount <= 0) return { error: 0, ok: total, gap: 0 };
  const error = Math.max(MIN_ERROR_HEIGHT, (bucket.errorCount / scaleMax) * plotHeight);
  if (okCount <= 0) return { error: Math.min(plotHeight, error), ok: 0, gap: 0 };
  const ok = Math.max(1, total - error - BAR_GAP);
  return { error, ok, gap: BAR_GAP };
}

/**
 * A bucket in words: "Oct 9", "Oct 9 to Oct 15" or "Oct 9, 10:00 to 12:00 UTC".
 * Hours say their zone unless the caller already does (a "Time (UTC)" header).
 */
export function bucketLabel(
  bucket: VolumeBucket,
  stepHours: number,
  { zone = true }: { zone?: boolean } = {},
): string {
  if (stepHours >= 24) return formatDayRange(bucket.fromDay, bucket.toDay);
  const start = new Date(bucket.startMs);
  const endsAtMidnight = bucket.endMs % DAY_MS === 0;
  const end = endsAtMidnight ? "24:00" : formatClock(new Date(bucket.endMs));
  return `${formatDay(bucket.fromDay)}, ${formatClock(start)} to ${end}${zone ? `${NBSP}UTC` : ""}`;
}

export interface AxisLabel {
  index: number;
  label: string;
}

/**
 * Recessive x-axis labels, about `target` of them: hours inside a single day,
 * day starts across a few days, and every n-th bucket for longer windows.
 */
export function axisLabels(
  model: Pick<VolumeModel, "buckets" | "stepHours">,
  target = 6,
): AxisLabel[] {
  const { buckets, stepHours } = model;
  if (buckets.length === 0) return [];
  const days = new Set(buckets.map((bucket) => bucket.fromDay)).size;
  if (stepHours < 24 && days <= 1) {
    const every = Math.max(1, Math.ceil(buckets.length / target));
    return buckets.flatMap((bucket, index) =>
      index % every === 0 ? [{ index, label: formatClock(new Date(bucket.startMs)) }] : [],
    );
  }
  if (stepHours < 24) {
    const dayStarts = buckets.flatMap((bucket, index) =>
      bucket.startMs % DAY_MS === 0 ? [{ index, label: formatDay(bucket.fromDay) }] : [],
    );
    const every = Math.max(1, Math.ceil(dayStarts.length / target));
    return dayStarts.filter((_, position) => position % every === 0);
  }
  const every = Math.max(1, Math.ceil(buckets.length / target));
  return buckets.flatMap((bucket, index) =>
    index % every === 0 ? [{ index, label: formatDay(bucket.fromDay) }] : [],
  );
}

function dayCount(from: string, to: string): number {
  return Math.round((dayMs(to) - dayMs(from)) / DAY_MS) + 1;
}

function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function query(params: URLSearchParams): string {
  const text = params.toString();
  return text ? `?${text}` : "";
}
