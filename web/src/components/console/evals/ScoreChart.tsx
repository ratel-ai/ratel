"use client";

import { useState } from "react";
import { useSize } from "@/components/console/dashboards/use-size";
import { formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import { type ChartSeries, percent, timeLabel } from "@/lib/views/evals/evals-page";

/** Written out whole: the only colors a series can have, in slot order. */
const SLOT_COLOR = [
  "var(--ds-chart-1)",
  "var(--ds-chart-2)",
  "var(--ds-chart-3)",
  "var(--ds-chart-4)",
  "var(--ds-chart-5)",
  "var(--ds-chart-6)",
] as const;

const HEIGHT = 200;
const TOP = 10;
const BOTTOM = 24;
/** Room for the y labels at the left. */
const LEFT = 40;
/** Room so the last marker is not cut. */
const RIGHT = 8;
const NOMINAL_WIDTH = 640;
const GRID = [0, 0.25, 0.5, 0.75, 1];
const MARKER = 4;

type Hit = { series: ChartSeries; index: number; x: number; y: number };

/**
 * Scores over time (DESIGN.md, Data visualization): one 2 px line for each series, y from 0 to
 * 100%, x the time of each run, the legend at the right. A marker is a run: hover reads it and a
 * click opens it. With one run a series is one marker. The colors follow the series slot.
 */
export function ScoreChart({
  series,
  label,
  now,
}: {
  series: readonly ChartSeries[];
  /** What the chart shows, for its accessible name. */
  label: string;
  now: string;
}) {
  const [hostRef, { width }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<Hit | null>(null);
  const plotWidth = (width || NOMINAL_WIDTH) - LEFT - RIGHT;
  const plotHeight = HEIGHT - TOP - BOTTOM;
  const times = series.flatMap(({ points }) => points.map(({ at }) => Date.parse(at)));
  const first = Math.min(...times);
  const last = Math.max(...times);
  const span = last - first;
  const xOf = (at: string) =>
    LEFT + (span > 0 ? ((Date.parse(at) - first) / span) * plotWidth : plotWidth / 2);
  const yOf = (score: number) => TOP + (1 - score) * plotHeight;
  const hits: Hit[] = series.flatMap((one) =>
    one.points.flatMap((point, index) =>
      point.score === null ? [] : [{ series: one, index, x: xOf(point.at), y: yOf(point.score) }],
    ),
  );
  const ticks = span > 0 ? [first, first + span / 2, last] : [first];

  return (
    <figure className="m-0 flex flex-col gap-4 md:flex-row">
      <div
        ref={hostRef}
        className="relative min-w-0 flex-1 select-none"
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const y = event.clientY - rect.top;
          setHover(nearest(hits, x, y));
        }}
        onPointerLeave={() => setHover(null)}
      >
        <svg
          role="img"
          aria-label={label}
          viewBox={`0 0 ${width || NOMINAL_WIDTH} ${HEIGHT}`}
          width="100%"
          height={HEIGHT}
          className="block overflow-visible"
        >
          {GRID.map((step) => (
            <g key={step}>
              <line
                x1={LEFT}
                x2={LEFT + plotWidth}
                y1={yOf(step)}
                y2={yOf(step)}
                className="stroke-line"
                strokeWidth={1}
              />
              <text
                x={LEFT - 8}
                y={yOf(step)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-fg-subtle text-[11px] tabular-nums"
              >
                {Math.round(step * 100)}%
              </text>
            </g>
          ))}
          {ticks.map((tick, index) => (
            <text
              key={tick}
              x={span > 0 ? LEFT + ((tick - first) / span) * plotWidth : LEFT + plotWidth / 2}
              y={HEIGHT - 6}
              textAnchor={
                ticks.length === 1
                  ? "middle"
                  : index === 0
                    ? "start"
                    : index === ticks.length - 1
                      ? "end"
                      : "middle"
              }
              className="fill-fg-subtle text-[11px]"
            >
              {timeLabel(tick, span)}
            </text>
          ))}
          {hover ? (
            <line
              x1={hover.x}
              x2={hover.x}
              y1={TOP}
              y2={TOP + plotHeight}
              className="stroke-line-strong"
              strokeDasharray="3 3"
            />
          ) : null}
          {series.map((one) => {
            const color = SLOT_COLOR[one.slot % SLOT_COLOR.length];
            const segments = lineRuns(one.points.map(({ score }) => score));
            return (
              <g key={one.id}>
                {segments.map((run) => (
                  <polyline
                    key={run[0]}
                    fill="none"
                    stroke={color}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    points={run
                      .map((index) => {
                        const point = one.points[index];
                        return point && point.score !== null
                          ? `${xOf(point.at)},${yOf(point.score)}`
                          : "";
                      })
                      .join(" ")}
                  />
                ))}
                {one.points.map((point) =>
                  point.score === null ? null : (
                    <a
                      key={point.experimentId}
                      href={point.href}
                      aria-label={`${one.name}: ${percent(point.score)}, ${formatRelativeTime(point.at, now)}`}
                    >
                      <circle
                        cx={xOf(point.at)}
                        cy={yOf(point.score)}
                        r={MARKER}
                        fill={color}
                        className="stroke-app"
                        strokeWidth={2}
                      />
                    </a>
                  ),
                )}
              </g>
            );
          })}
        </svg>
        {hover ? <Tooltip hit={hover} now={now} width={width || NOMINAL_WIDTH} /> : null}
      </div>
      <ul aria-label="Legend" className="flex shrink-0 flex-col gap-1.5 text-ui md:w-52">
        {series.map((one) => {
          const latest = [...one.points].reverse().find(({ score }) => score !== null);
          return (
            <li key={one.id} className="flex items-center gap-2">
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-full"
                style={{ background: SLOT_COLOR[one.slot % SLOT_COLOR.length] }}
              />
              <span className="min-w-0 flex-1 truncate text-fg">{one.name}</span>
              <span className="tabular-nums text-fg-muted">{percent(latest?.score ?? null)}</span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

function Tooltip({ hit, now, width }: { hit: Hit; now: string; width: number }) {
  const point = hit.series.points[hit.index];
  if (!point) return null;
  const left = Math.min(hit.x + 12, width - 200);
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-popover w-48 rounded-md border border-line bg-raised px-3 py-2 text-xs shadow-md"
      style={{ left, top: Math.max(0, hit.y - 48) }}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{ background: SLOT_COLOR[hit.series.slot % SLOT_COLOR.length] }}
        />
        <span className="truncate font-medium text-fg">{hit.series.name}</span>
      </div>
      <div className="mt-1 flex justify-between text-fg-muted">
        <span>{formatRelativeTime(point.at, now)}</span>
        <span className="tabular-nums text-fg">{percent(point.score)}</span>
      </div>
    </div>
  );
}

/** The marker nearest to the pointer, within 40 px. */
function nearest(hits: readonly Hit[], x: number, y: number): Hit | null {
  let best: Hit | null = null;
  let distance = 40;
  for (const hit of hits) {
    const d = Math.hypot(hit.x - x, hit.y - y);
    if (d < distance) {
      best = hit;
      distance = d;
    }
  }
  return best;
}

/** Runs of consecutive scored points, so a line breaks where a run has no score. */
function lineRuns(scores: readonly (number | null)[]): number[][] {
  const runs: number[][] = [];
  let current: number[] = [];
  for (const [index, score] of scores.entries()) {
    if (score === null) {
      if (current.length > 0) runs.push(current);
      current = [];
    } else current.push(index);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}
