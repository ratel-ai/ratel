"use client";

import { cn } from "@ratel/design-system/cn";
import { EmptyState } from "@ratel/design-system/states";
import { LineChart } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ChartLine,
  percent,
  type ScoreChart as ScoreChartModel,
} from "@/lib/views/evals/score-chart";

/** Written out whole: the only colors a line can have (DESIGN.md, Data visualization). */
const SLOT_COLOR = [
  "var(--ds-chart-1)",
  "var(--ds-chart-2)",
  "var(--ds-chart-3)",
  "var(--ds-chart-4)",
  "var(--ds-chart-5)",
  "var(--ds-chart-6)",
] as const;
const MEAN_COLOR = "var(--ds-fg-muted)";

/** Room above the top gridline, and at each side, so a marker is never cut. */
const PAD_TOP = 10;
const PAD_X = 10;
const PLOT_HEIGHT = 180;
const AXIS_HEIGHT = 24;
const Y_AXIS = 40;
const NOMINAL_WIDTH = 640;
/** One run alone sits in the middle of a window this wide. */
const LONE_WINDOW_MS = 2 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

type Run = { runId: string; at: number; points: Array<{ line: ChartLine; value: number }> };

/**
 * A score over the time of the runs: one measure, from 0 to 100%, one line for each eval (or for
 * each scorer, and their mean dashed). A legend on the right names each line next to its newest
 * score. Hover or the arrow keys read a run. With no run, the chart says so; with one, it shows its
 * points and says that a line starts with the second run. Times are UTC.
 */
export function ScoreChart({
  chart,
  label,
  emptyTitle,
  emptyDescription,
}: {
  chart: ScoreChartModel;
  /** What the chart measures, for its accessible name. */
  label: string;
  emptyTitle: string;
  emptyDescription: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const baseId = useId();

  const empty = chart.runs === 0;
  useEffect(() => {
    const host = hostRef.current;
    if (!host || empty) return;
    const measure = () => setWidth(host.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [empty]);

  const runs = useMemo(() => runsOf(chart.lines), [chart.lines]);
  if (empty) {
    return (
      <figure className="m-0 rounded-lg border border-line bg-raised">
        <EmptyState icon={LineChart} title={emptyTitle} description={emptyDescription} />
      </figure>
    );
  }

  const plotWidth = Math.max(120, width || NOMINAL_WIDTH);
  const first = runs[0]?.at ?? 0;
  const last = runs.at(-1)?.at ?? first;
  const [start, end] =
    first === last ? [first - LONE_WINDOW_MS / 2, last + LONE_WINDOW_MS / 2] : [first, last];
  const xOf = (at: number) => PAD_X + ((at - start) / (end - start)) * (plotWidth - 2 * PAD_X);
  const yOf = (value: number) => PAD_TOP + (1 - value) * PLOT_HEIGHT;
  const baseline = PAD_TOP + PLOT_HEIGHT;
  const active = hover ?? cursor;
  const activeRun = active === null ? null : runs[active];

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const lastIndex = runs.length - 1;
    const at = cursor ?? lastIndex;
    const next =
      event.key === "ArrowLeft"
        ? Math.max(0, at - (cursor === null ? 0 : 1))
        : event.key === "ArrowRight"
          ? Math.min(lastIndex, at + 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? lastIndex
              : null;
    if (next === null) return;
    event.preventDefault();
    setCursor(next);
  }

  return (
    <figure className="m-0 flex flex-col gap-3 rounded-lg border border-line bg-raised p-4">
      <div className="flex flex-col gap-4 md:flex-row">
        <div className="flex min-w-0 flex-1">
          <div
            aria-hidden
            className="relative shrink-0"
            style={{ width: Y_AXIS, height: baseline + AXIS_HEIGHT }}
          >
            {[1, 0.5, 0].map((value) => (
              <span
                key={value}
                className="absolute right-2 -translate-y-1/2 text-xs leading-4 text-fg-subtle tabular-nums"
                style={{ top: yOf(value) }}
              >
                {percent(value)}
              </span>
            ))}
          </div>
          <div
            ref={hostRef}
            role="listbox"
            tabIndex={0}
            aria-readonly
            aria-label={`${label}, by run`}
            aria-activedescendant={cursor !== null ? `${baseId}-${cursor}` : undefined}
            onKeyDown={onKeyDown}
            onBlur={() => setCursor(null)}
            onPointerMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * plotWidth;
              setHover(nearest(runs, (run) => Math.abs(xOf(run.at) - x)));
            }}
            onPointerLeave={() => setHover(null)}
            className="relative min-w-0 flex-1 touch-pan-y rounded-md outline-none select-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app"
            style={{ height: baseline + AXIS_HEIGHT }}
          >
            <svg
              viewBox={`0 0 ${plotWidth} ${baseline}`}
              width="100%"
              height={baseline}
              preserveAspectRatio="none"
              aria-hidden="true"
              className="block overflow-visible"
            >
              {[1, 0.5].map((value) => (
                <line
                  key={value}
                  x1={0}
                  x2={plotWidth}
                  y1={yOf(value) + 0.5}
                  y2={yOf(value) + 0.5}
                  stroke="var(--ds-line)"
                  strokeWidth={1}
                />
              ))}
              <line
                x1={0}
                x2={plotWidth}
                y1={baseline - 0.5}
                y2={baseline - 0.5}
                stroke="var(--ds-line-strong)"
                strokeWidth={1}
              />
              {activeRun ? (
                <line
                  x1={xOf(activeRun.at)}
                  x2={xOf(activeRun.at)}
                  y1={PAD_TOP}
                  y2={baseline}
                  stroke="var(--ds-line-active)"
                  strokeWidth={1}
                />
              ) : null}
              {chart.lines.map((line) => {
                const color = colorOf(line);
                const coords = line.points.map(
                  (point) => [xOf(Date.parse(point.at)), yOf(point.value)] as const,
                );
                return (
                  <g key={line.key}>
                    {coords.length > 1 ? (
                      <polyline
                        points={coords.map(([x, y]) => `${x},${y}`).join(" ")}
                        fill="none"
                        stroke={color}
                        strokeWidth={2}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        strokeDasharray={line.slot === "mean" ? "5 4" : undefined}
                        vectorEffect="non-scaling-stroke"
                      />
                    ) : null}
                    {coords.map(([x, y], index) => (
                      <circle
                        key={line.points[index]?.runId}
                        cx={x}
                        cy={y}
                        r={line.points[index]?.runId === activeRun?.runId ? 5 : 4}
                        fill={color}
                        stroke="var(--ds-raised)"
                        strokeWidth={2}
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                  </g>
                );
              })}
            </svg>
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 h-6"
              style={{ top: baseline }}
            >
              {timeTicks(start, end, Math.max(2, Math.floor(plotWidth / 140))).map((tick) => {
                const ratio = xOf(tick) / plotWidth;
                return (
                  <span
                    key={tick}
                    className={cn(
                      "absolute top-1.5 text-xs leading-4 whitespace-nowrap text-fg-subtle tabular-nums",
                      ratio < 0.08
                        ? "translate-x-0"
                        : ratio > 0.92
                          ? "-translate-x-full"
                          : "-translate-x-1/2",
                    )}
                    style={{ left: `${ratio * 100}%` }}
                  >
                    {timeLabel(tick, end - start)}
                  </span>
                );
              })}
            </div>
            {runs.map((run, index) => (
              <div
                key={run.runId}
                id={`${baseId}-${index}`}
                role="option"
                tabIndex={-1}
                aria-selected={cursor === index}
                className="sr-only"
              >
                {`${timeLabel(run.at, 0)}: ${run.points
                  .map(({ line, value }) => `${line.label} ${percent(value)}`)
                  .join(", ")}`}
              </div>
            ))}
            {activeRun ? (
              <Readout
                run={activeRun}
                style={
                  xOf(activeRun.at) < plotWidth / 2
                    ? { left: `${((xOf(activeRun.at) + 12) / plotWidth) * 100}%` }
                    : { right: `${(1 - (xOf(activeRun.at) - 12) / plotWidth) * 100}%` }
                }
              />
            ) : null}
          </div>
        </div>
        <Legend lines={chart.lines} />
      </div>
      {chart.note ? <figcaption className="text-xs text-fg-subtle">{chart.note}</figcaption> : null}
    </figure>
  );
}

function Legend({ lines }: { lines: readonly ChartLine[] }) {
  return (
    <ul aria-label="Legend" className="flex shrink-0 flex-col gap-1.5 md:w-56">
      {lines.map((line) => {
        const newest = line.points.at(-1);
        return (
          <li key={line.key} className="flex items-center gap-2 text-ui">
            <Swatch line={line} />
            <span className="min-w-0 flex-1 truncate text-fg" title={line.label}>
              {line.label}
            </span>
            <span className="text-fg-muted tabular-nums">
              {newest ? percent(newest.value) : "No run"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Swatch({ line }: { line: ChartLine }) {
  return line.slot === "mean" ? (
    <span
      aria-hidden
      className="h-0 w-3 shrink-0 border-t-2 border-dashed"
      style={{ borderColor: MEAN_COLOR }}
    />
  ) : (
    <span
      aria-hidden
      className="size-2.5 shrink-0 rounded-sm"
      style={{ background: colorOf(line) }}
    />
  );
}

function Readout({ run, style }: { run: Run; style: CSSProperties }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute top-0 z-sticky flex min-w-40 flex-col gap-1 rounded-lg border border-line bg-overlay px-3 py-2 text-xs shadow-overlay"
      style={style}
    >
      <span className="text-fg-subtle tabular-nums">{timeLabel(run.at, 0)}</span>
      {run.points.map(({ line, value }) => (
        <span key={line.key} className="flex items-center gap-2">
          <Swatch line={line} />
          <span className="min-w-0 flex-1 truncate text-fg">{line.label}</span>
          <span className="text-fg tabular-nums">{percent(value)}</span>
        </span>
      ))}
    </div>
  );
}

/** Each run with a point, the oldest first, with the points of each line at that run. */
function runsOf(lines: readonly ChartLine[]): Run[] {
  const byRun = new Map<string, Run>();
  for (const line of lines) {
    for (const point of line.points) {
      const run = byRun.get(point.runId) ?? {
        runId: point.runId,
        at: Date.parse(point.at),
        points: [],
      };
      run.points.push({ line, value: point.value });
      byRun.set(point.runId, run);
    }
  }
  return [...byRun.values()].sort((a, b) => a.at - b.at);
}

function nearest<T>(items: readonly T[], distance: (item: T) => number): number | null {
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  items.forEach((item, index) => {
    const d = distance(item);
    if (d < bestDistance) {
      best = index;
      bestDistance = d;
    }
  });
  return best;
}

/** Ticks across the window: each UTC midnight for a window of days, else even times. */
function timeTicks(start: number, end: number, count: number): number[] {
  if (end - start > 2 * DAY_MS) {
    const days: number[] = [];
    for (let at = Math.ceil(start / DAY_MS) * DAY_MS; at <= end; at += DAY_MS) days.push(at);
    const step = Math.max(1, Math.ceil(days.length / count));
    return days.filter((_, index) => index % step === 0);
  }
  const step = (end - start) / count;
  return Array.from({ length: count + 1 }, (_, index) => start + step * index);
}

/** A day and a time, or only the day for a long window. UTC. */
function timeLabel(at: number, span: number): string {
  const iso = new Date(at).toISOString();
  const day = new Date(at).toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return span > 2 * DAY_MS ? day : `${day} ${iso.slice(11, 16)}`;
}

function colorOf(line: ChartLine): string {
  return line.slot === "mean" ? MEAN_COLOR : (SLOT_COLOR[line.slot] ?? SLOT_COLOR[0]);
}
