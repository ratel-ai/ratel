"use client";

import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { smoothPath } from "@/lib/platform/chart";
import { type CurvePoint, percentDomain } from "@/lib/views/adaptive-ranking/ranking";

/**
 * How often the right tool came first, with adaptive ranking and without it,
 * as the searches added up. One chart, two lines (DESIGN.md, Data
 * visualization): the comparison is neutral, the graph's line is the first
 * categorical color. Hover or arrow keys move a crosshair; the values at it
 * are written above the chart, never in a floating box.
 *
 * The drawing is one image with one name. The crosshair control is a slider
 * laid over the plot, outside the image, so nothing focusable hides inside a
 * role that has no children.
 */

const HEIGHT = 220;
const PAD = { top: 12, right: 12, bottom: 28, left: 40 };
const pct = (value: number | null) => (value === null ? "no data" : `${Math.round(value * 100)}%`);

export function RankingChart({
  points,
  estimated,
}: {
  points: readonly CurvePoint[];
  estimated: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const domain = percentDomain(points.flatMap((point) => [point.withGraph, point.without]));
  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const first = points[0]?.turn ?? 0;
  const last = points[points.length - 1]?.turn ?? 1;
  const x = (turn: number) =>
    PAD.left + (last > first ? ((turn - first) / (last - first)) * plotW : 0);
  const y = (value: number) =>
    PAD.top + plotH * (1 - (value - domain.low) / Math.max(0.0001, domain.high - domain.low));
  const line = (key: "withGraph" | "without") =>
    smoothPath(
      points
        .filter((point) => point[key] !== null)
        .map((point) => [x(point.turn), y(point[key]!)] as const),
    );
  const lastIndex = points.length - 1;
  const at = cursor !== null ? points[cursor] : points[lastIndex];
  const withLabel = estimated ? "With adaptive ranking (estimated)" : "With adaptive ranking";
  const reading = (point: CurvePoint | undefined) =>
    point
      ? `After ${point.turn.toLocaleString("en-US")} searches: ${pct(point.withGraph)} with adaptive ranking, ${pct(point.without)} without it`
      : "";

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (points.length === 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const turn =
      first + ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * (last - first);
    let best = 0;
    for (let index = 1; index < points.length; index += 1) {
      if (Math.abs(points[index]!.turn - turn) < Math.abs(points[best]!.turn - turn)) best = index;
    }
    setCursor(best);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = cursor ?? lastIndex;
    const next =
      event.key === "ArrowRight" || event.key === "ArrowUp"
        ? current + 1
        : event.key === "ArrowLeft" || event.key === "ArrowDown"
          ? current - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? lastIndex
              : null;
    if (next === null) return;
    event.preventDefault();
    setCursor(Math.min(lastIndex, Math.max(0, next)));
  }

  return (
    <figure className="flex flex-col gap-3">
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-0.5 w-4 rounded-full bg-chart-1" />
          {withLabel}{" "}
          <span className="font-medium text-fg tabular-nums">{pct(at?.withGraph ?? null)}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-0.5 w-4 rounded-full bg-fg-faint" />
          Without it{" "}
          <span className="font-medium text-fg tabular-nums">{pct(at?.without ?? null)}</span>
        </span>
        <span className="text-fg-subtle tabular-nums">
          {at ? `after ${at.turn.toLocaleString("en-US")} searches` : null}
        </span>
      </figcaption>
      <div ref={containerRef} className="relative w-full">
        {width > 0 && points.length > 1 ? (
          <>
            <svg
              width={width}
              height={HEIGHT}
              role="img"
              aria-label={`${reading(points[lastIndex])}.`}
              className="block overflow-visible"
            >
              {domain.ticks.map((tick) => (
                <g key={tick}>
                  <line
                    x1={PAD.left}
                    x2={width - PAD.right}
                    y1={y(tick)}
                    y2={y(tick)}
                    className="stroke-line"
                    strokeWidth={1}
                  />
                  <text
                    x={PAD.left - 8}
                    y={y(tick)}
                    textAnchor="end"
                    dominantBaseline="central"
                    className="fill-fg-subtle text-xs tabular-nums"
                  >
                    {Math.round(tick * 100)}%
                  </text>
                </g>
              ))}
              <text x={PAD.left} y={HEIGHT - 6} className="fill-fg-subtle text-xs tabular-nums">
                {first.toLocaleString("en-US")}
              </text>
              <text
                x={width - PAD.right}
                y={HEIGHT - 6}
                textAnchor="end"
                className="fill-fg-subtle text-xs tabular-nums"
              >
                {last.toLocaleString("en-US")} searches
              </text>
              <path
                d={line("without")}
                className="fill-none stroke-fg-faint"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d={line("withGraph")}
                className="fill-none stroke-chart-1"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {at && cursor !== null ? (
                <g>
                  <line
                    x1={x(at.turn)}
                    x2={x(at.turn)}
                    y1={PAD.top}
                    y2={HEIGHT - PAD.bottom}
                    className="stroke-line-active"
                    strokeWidth={1}
                  />
                  {at.without !== null ? (
                    <circle
                      cx={x(at.turn)}
                      cy={y(at.without)}
                      r={4}
                      className="fill-app stroke-fg-faint"
                      strokeWidth={2}
                    />
                  ) : null}
                  {at.withGraph !== null ? (
                    <circle
                      cx={x(at.turn)}
                      cy={y(at.withGraph)}
                      r={4}
                      className="fill-app stroke-chart-1"
                      strokeWidth={2}
                    />
                  ) : null}
                </g>
              ) : null}
            </svg>
            {/* The crosshair: over the plot, larger than the lines, outside the image. */}
            <div
              role="slider"
              tabIndex={0}
              aria-label="Read the chart at a point"
              aria-valuemin={first}
              aria-valuemax={last}
              aria-valuenow={at?.turn ?? last}
              aria-valuetext={reading(at)}
              className="absolute rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
              style={{ left: PAD.left, top: PAD.top, width: plotW, height: plotH }}
              onPointerMove={onPointerMove}
              onPointerLeave={() => setCursor(null)}
              onBlur={() => setCursor(null)}
              onKeyDown={onKeyDown}
            />
          </>
        ) : (
          <div style={{ height: HEIGHT }} aria-hidden />
        )}
      </div>
    </figure>
  );
}
