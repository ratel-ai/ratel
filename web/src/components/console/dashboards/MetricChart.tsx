"use client";

import { cn } from "@ratel/design-system/cn";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { smoothPath } from "@/lib/platform/chart";
import type { MetricUnit } from "@/lib/synthesis/metrics/catalog";
import type { MetricResult } from "@/lib/synthesis/metrics/query";
import { BAR_RADIUS, barLayout } from "@/lib/synthesis/traces/v2/volume";
import {
  axisTicks,
  bucketName,
  type ChartModel,
  type ChartSeries,
  formatMetric,
  lineSegments,
} from "@/lib/views/dashboards/chart-model";

/** Room above the top gridline for its label. */
const PLOT_TOP = 18;
const PLOT_HEIGHT = 132;
const BASELINE = PLOT_TOP + PLOT_HEIGHT;
/** Width drawn before the browser measures; the viewBox makes it fit until then. */
const NOMINAL_WIDTH = 520;
/** The gap between a stack's segments. */
const SEGMENT_GAP = 2;

/** Written out whole: the only colors a series can have. */
const SLOT_COLOR = [
  "var(--ds-chart-1)",
  "var(--ds-chart-2)",
  "var(--ds-chart-3)",
  "var(--ds-chart-4)",
  "var(--ds-chart-5)",
  "var(--ds-chart-6)",
] as const;

/**
 * A metric over time, as lines or bars (DESIGN.md, Data visualization): 2 px lines, 4 px rounded
 * bar ends, one axis, colors in slot order. Hover or the arrow keys read a bucket. Times are UTC.
 */
export function MetricChart({
  chart,
  model,
  result,
  unit,
  label,
  threshold,
}: {
  chart: "line" | "bar";
  model: ChartModel;
  result: MetricResult;
  unit: MetricUnit;
  /** What the chart measures, for its accessible name. */
  label: string;
  /** A dashed line at this value, within the scale. */
  threshold?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const baseId = useId();
  const { buckets, bucket } = result;
  const { series, scaleMax } = model;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => setWidth(host.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const plotWidth = width || NOMINAL_WIDTH;
  const layout = barLayout(plotWidth, buckets.length);
  const centerOf = (index: number) => layout.slot * (index + 0.5);
  const yOf = (value: number) =>
    BASELINE - Math.min(1, scaleMax > 0 ? value / scaleMax : 0) * PLOT_HEIGHT;
  const active = hover ?? cursor;
  const named = series.length > 1 || series[0]?.label !== "";

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const last = buckets.length - 1;
    const at = cursor ?? last;
    const next =
      event.key === "ArrowLeft"
        ? Math.max(0, at - (cursor === null ? 0 : 1))
        : event.key === "ArrowRight"
          ? Math.min(last, at + 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    setCursor(next);
  }

  return (
    <figure className="m-0 flex flex-col gap-2">
      {named ? <Legend series={series} /> : null}
      {/* A listbox of time buckets, as the Traces volume chart is: the marks are drawn, the
          options say them for assistive tech. */}
      <div
        ref={hostRef}
        role="listbox"
        tabIndex={0}
        aria-readonly
        aria-label={`${label}, by ${bucket}`}
        aria-activedescendant={cursor !== null ? `${baseId}-${cursor}` : undefined}
        onKeyDown={onKeyDown}
        onBlur={() => setCursor(null)}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - rect.left) / Math.max(1, rect.width);
          setHover(Math.min(buckets.length - 1, Math.max(0, Math.floor(ratio * buckets.length))));
        }}
        onPointerLeave={() => setHover(null)}
        className="relative touch-pan-y rounded-md outline-none select-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app"
        style={{ height: BASELINE + 24 }}
      >
        <svg
          viewBox={`0 0 ${plotWidth} ${BASELINE}`}
          width="100%"
          height={BASELINE}
          preserveAspectRatio="none"
          aria-hidden="true"
          className="block overflow-visible"
        >
          {[PLOT_TOP, PLOT_TOP + PLOT_HEIGHT / 2].map((y) => (
            <line
              key={y}
              x1={0}
              x2={plotWidth}
              y1={y + 0.5}
              y2={y + 0.5}
              stroke="var(--ds-line)"
              strokeWidth={1}
            />
          ))}
          {active !== null ? (
            <rect
              x={active * layout.slot}
              width={layout.slot}
              y={PLOT_TOP}
              height={PLOT_HEIGHT}
              fill="var(--ds-hover)"
            />
          ) : null}
          {chart === "line" ? (
            <Lines series={series} centerOf={centerOf} yOf={yOf} active={active} />
          ) : (
            <Bars model={model} count={buckets.length} layout={layout} yOf={yOf} />
          )}
          {threshold === undefined ? null : (
            <line
              x1={0}
              x2={plotWidth}
              y1={yOf(threshold)}
              y2={yOf(threshold)}
              stroke="var(--ds-danger)"
              strokeWidth={1.5}
              strokeDasharray="4 4"
            />
          )}
          <line
            x1={0}
            x2={plotWidth}
            y1={BASELINE - 0.5}
            y2={BASELINE - 0.5}
            stroke="var(--ds-line-strong)"
            strokeWidth={1}
          />
        </svg>

        {threshold === undefined ? null : (
          <span
            aria-hidden
            className="pointer-events-none absolute right-0 bg-app px-1 text-xs leading-4 text-danger tabular-nums"
            style={{ top: yOf(threshold) - 8 }}
          >
            {formatMetric(threshold, unit)}
          </span>
        )}
        {buckets.map((start, index) => (
          <div
            key={start}
            id={`${baseId}-${index}`}
            role="option"
            tabIndex={-1}
            aria-selected={cursor === index}
            className="sr-only"
          >
            {`${bucketName(start, bucket)}: ${series
              .map(
                (item) =>
                  `${item.label ? `${item.label} ` : ""}${formatMetric(item.values[index], unit)}`,
              )
              .join(", ")}`}
          </div>
        ))}

        <span
          aria-hidden
          className="pointer-events-none absolute top-0 left-0 text-xs leading-4 text-fg-subtle tabular-nums"
        >
          {formatMetric(scaleMax, unit)}
        </span>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 h-6"
          style={{ top: BASELINE }}
        >
          {axisTicks(buckets, bucket, Math.max(2, Math.floor(plotWidth / 110))).map((tick) => {
            const ratio = centerOf(tick.index) / plotWidth;
            return (
              <span
                key={tick.index}
                className={cn(
                  "absolute top-1.5 text-xs leading-4 whitespace-nowrap text-fg-subtle tabular-nums",
                  ratio < 0.06
                    ? "translate-x-0"
                    : ratio > 0.94
                      ? "-translate-x-full"
                      : "-translate-x-1/2",
                )}
                style={{ left: `${ratio < 0.06 ? 0 : ratio > 0.94 ? 100 : ratio * 100}%` }}
              >
                {tick.label}
              </span>
            );
          })}
        </div>

        {active !== null && buckets[active] ? (
          <Readout
            title={bucketName(buckets[active], bucket)}
            series={series}
            index={active}
            unit={unit}
            // Beside the bucket it reads, never over it.
            style={
              active < buckets.length / 2
                ? { left: `${((layout.slot * (active + 1) + 8) / plotWidth) * 100}%` }
                : { right: `${(1 - (layout.slot * active - 8) / plotWidth) * 100}%` }
            }
          />
        ) : null}
      </div>
      {model.note ? <figcaption className="text-xs text-fg-subtle">{model.note}</figcaption> : null}
    </figure>
  );
}

function Lines({
  series,
  centerOf,
  yOf,
  active,
}: {
  series: readonly ChartSeries[];
  centerOf: (index: number) => number;
  yOf: (value: number) => number;
  active: number | null;
}) {
  return series.map((item) => {
    const color = colorOf(item);
    const point = (index: number) => [centerOf(index), yOf(item.values[index] ?? 0)] as const;
    const value = active === null ? null : item.values[active];
    return (
      <g key={item.key}>
        {lineSegments(item.values).map((segment) =>
          segment.length === 1 ? (
            <circle
              key={segment[0]}
              cx={point(segment[0])[0]}
              cy={point(segment[0])[1]}
              r={2.5}
              fill={color}
            />
          ) : (
            <path
              key={segment[0]}
              d={smoothPath(segment.map(point))}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ),
        )}
        {active !== null && value !== null && value !== undefined ? (
          <circle
            cx={point(active)[0]}
            cy={point(active)[1]}
            r={4}
            fill={color}
            stroke="var(--ds-app)"
            strokeWidth={2}
          />
        ) : null}
      </g>
    );
  });
}

function Bars({
  model,
  count,
  layout,
  yOf,
}: {
  model: ChartModel;
  count: number;
  layout: ReturnType<typeof barLayout>;
  yOf: (value: number) => number;
}) {
  const { series, stacked } = model;
  return Array.from({ length: count }, (_, index) => index).flatMap((index) => {
    if (stacked) {
      let below = 0;
      const drawn = series.flatMap((item) => {
        const value = item.values[index] ?? 0;
        if (value <= 0) return [];
        const bottom = yOf(below);
        below += value;
        return [{ item, bottom, top: yOf(below) }];
      });
      return drawn.map(({ item, bottom, top }, position) => {
        const gap = position > 0 ? Math.min(SEGMENT_GAP, (bottom - top) / 2) : 0;
        return (
          <path
            key={`${index}-${item.key}`}
            d={barPath(
              layout.x(index),
              top,
              layout.barWidth,
              bottom - gap - top,
              position === drawn.length - 1,
            )}
            fill={colorOf(item)}
          />
        );
      });
    }
    const each = layout.barWidth / series.length;
    const gap = each > 4 ? 1 : 0;
    return series.flatMap((item, position) => {
      const value = item.values[index] ?? 0;
      if (value <= 0) return [];
      const top = Math.min(yOf(value), BASELINE - 2);
      return [
        <path
          key={`${index}-${item.key}`}
          d={barPath(
            layout.x(index) + each * position,
            top,
            Math.max(1, each - gap),
            BASELINE - top,
            true,
          )}
          fill={colorOf(item)}
        />,
      ];
    });
  });
}

function Legend({ series }: { series: readonly ChartSeries[] }) {
  return (
    <ul
      aria-label="Legend"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted"
    >
      {series.map((item) => (
        <li key={item.key} className="inline-flex max-w-full items-center gap-1.5">
          <Swatch series={item} />
          <span className="truncate" title={item.label}>
            {item.label}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Readout({
  title,
  series,
  index,
  unit,
  style,
}: {
  title: string;
  series: readonly ChartSeries[];
  index: number;
  unit: MetricUnit;
  style: React.CSSProperties;
}) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-sticky rounded-lg border border-line bg-overlay px-2.5 py-2 text-xs whitespace-nowrap shadow-overlay"
      style={{ top: PLOT_TOP, ...style }}
    >
      <p className="text-fg-subtle">{title}</p>
      {series.map((item) => (
        <p key={item.key} className="mt-1 flex items-center gap-2">
          <Swatch series={item} />
          <span className="font-semibold text-fg tabular-nums">
            {formatMetric(item.values[index], unit)}
          </span>
          {item.label ? (
            <span className="max-w-48 truncate text-fg-muted">{item.label}</span>
          ) : null}
        </p>
      ))}
    </div>
  );
}

function Swatch({ series }: { series: ChartSeries }) {
  return (
    <span
      aria-hidden
      className="size-2 shrink-0 rounded-[2px]"
      style={{ background: colorOf(series) }}
    />
  );
}

function colorOf({ slot }: ChartSeries): string {
  return slot === null ? "var(--ds-fg-faint)" : (SLOT_COLOR[slot - 1] ?? SLOT_COLOR[0]);
}

/** A bar segment; the top one has 4 px rounded corners. */
function barPath(x: number, y: number, width: number, height: number, rounded: boolean): string {
  if (!rounded) return `M${x},${y + height}V${y}H${x + width}V${y + height}Z`;
  const r = Math.max(0, Math.min(BAR_RADIUS, width / 2, height));
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}
