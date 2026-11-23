"use client";

import { cn } from "@ratel/design-system/cn";
import { useState } from "react";
import { formatClock, formatDay, formatInteger } from "@/lib/synthesis/traces/v2/format";
import {
  canSelectDays,
  type VolumeBucket,
  type VolumeModel,
} from "@/lib/synthesis/traces/v2/volume";

/** Chart height in px (DESIGN.md, Data visualization: big enough to read at a glance). */
export const MINI_VOLUME_HEIGHT = 56;
/** px between bars, in the chart's own units. */
const GAP = 1;

/**
 * The volume chart of a Traces tab's summary: one bar per bucket of the
 * timeframe in the data color, its errors in red on the baseline, start and
 * end labels under it, and the hovered bar's value above it. With
 * `onSelectDays`, a click on a bar narrows the window to its days, when the
 * window has more than one day to narrow to.
 */
export function MiniVolume({
  model,
  unit,
  errorLabel,
  className,
  onSelectDays,
}: {
  model: VolumeModel;
  unit: string;
  errorLabel: string;
  className?: string;
  onSelectDays?: (days: { from: string; to: string }) => void;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const buckets = model.buckets;
  if (buckets.length === 0) return null;
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const width = buckets.length * 4;
  const bar = width / buckets.length;
  const active = hovered === null ? null : buckets[hovered];
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  const select = onSelectDays && canSelectDays(buckets) ? onSelectDays : null;

  return (
    <figure
      className={cn("relative flex min-w-0 flex-col gap-1", className)}
      data-mini-volume
      aria-label={`${formatInteger(model.totals.count)} ${unit}, ${formatInteger(model.totals.errorCount)} ${errorLabel}, from ${bucketLabel(first, model.stepHours)} to ${bucketLabel(last, model.stepHours)}`}
    >
      <figcaption
        className="flex h-4 items-center justify-between gap-2 text-xs text-fg-subtle tabular-nums"
        data-volume-readout
      >
        {active ? (
          <span className="text-fg">
            {bucketLabel(active, model.stepHours)}: {formatInteger(active.count)} {unit}
            {active.errorCount > 0 ? (
              <span className="text-danger">
                , {formatInteger(active.errorCount)} {errorLabel}
              </span>
            ) : null}
            {select ? <span className="text-fg-subtle"> · click to zoom</span> : null}
          </span>
        ) : model.totals.count === 0 ? (
          <span>No {unit} in this timeframe</span>
        ) : (
          <span>{unit.charAt(0).toUpperCase() + unit.slice(1)} over time</span>
        )}
        {model.totals.count > 0 ? <span>max {formatInteger(max)}</span> : null}
      </figcaption>
      <svg
        aria-hidden
        width="100%"
        height={MINI_VOLUME_HEIGHT}
        viewBox={`0 0 ${width} ${MINI_VOLUME_HEIGHT}`}
        preserveAspectRatio="none"
        className="block"
        onMouseLeave={() => setHovered(null)}
      >
        <line
          x1={0}
          x2={width}
          y1={MINI_VOLUME_HEIGHT - 0.5}
          y2={MINI_VOLUME_HEIGHT - 0.5}
          stroke="var(--ds-line-strong)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {buckets.map((bucket, index) => {
          const total =
            bucket.count > 0 ? Math.max(2, (bucket.count / max) * (MINI_VOLUME_HEIGHT - 2)) : 0;
          const failed =
            bucket.count > 0 && bucket.errorCount > 0
              ? Math.max(2, (bucket.errorCount / bucket.count) * total)
              : 0;
          const x = index * bar;
          const w = Math.max(1, bar - GAP);
          const dim = hovered !== null && hovered !== index;
          return (
            <g key={bucket.startMs} opacity={dim ? 0.55 : 1} data-volume-bar={bucket.count}>
              {/* The whole column is the hover target, so empty buckets read too. */}
              <rect
                x={x}
                y={0}
                width={bar}
                height={MINI_VOLUME_HEIGHT}
                fill="transparent"
                className={select ? "cursor-pointer" : undefined}
                onMouseEnter={() => setHovered(index)}
                onClick={
                  select ? () => select({ from: bucket.fromDay, to: bucket.toDay }) : undefined
                }
              />
              {total > failed ? (
                <rect
                  x={x}
                  y={MINI_VOLUME_HEIGHT - total}
                  width={w}
                  height={total - failed}
                  fill="var(--ds-chart-1)"
                  pointerEvents="none"
                />
              ) : null}
              {failed > 0 ? (
                <rect
                  x={x}
                  y={MINI_VOLUME_HEIGHT - failed}
                  width={w}
                  height={failed}
                  fill="var(--ds-danger)"
                  pointerEvents="none"
                />
              ) : null}
            </g>
          );
        })}
      </svg>
      <div className="flex justify-between text-xs text-fg-subtle tabular-nums" data-volume-axis>
        <span>{bucketLabel(first, model.stepHours)}</span>
        <span>{bucketLabel(last, model.stepHours)}</span>
      </div>
    </figure>
  );
}

/** "Nov 8" for a day bucket, "Nov 8 09:00" for a bucket shorter than a day (UTC). */
export function bucketLabel(bucket: VolumeBucket, stepHours: number): string {
  return stepHours < 24
    ? `${formatDay(bucket.fromDay)} ${formatClock(new Date(bucket.startMs))}`
    : formatDay(bucket.fromDay);
}
