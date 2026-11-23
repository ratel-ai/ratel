"use client";

import { cn } from "@ratel/design-system/cn";
import Link from "next/link";
import { useState } from "react";

/** One slice of the ring: its share of the whole, its colour (an SVG paint), and where it leads, if anywhere. */
export interface RingSlice {
  key: string;
  label: string;
  value: number;
  share: number;
  color: string;
  href: string | null;
}

const SIZE = 120;
const RADIUS = 46;
const WIDTH = 16;
const POINTED_WIDTH = 20;
const GAP = 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const percent = (share: number) => `${Math.round(share * 100)}%`;

/**
 * A ring with a hole: each slice its share of the whole, the total in the
 * middle. Pointing at a slice (or focusing it) puts its share and label in
 * the middle and widens it; the others keep their colour (status colours
 * are never dimmed into muddy shades). A slice with a link opens it.
 */
export function StatusRing({
  slices,
  total,
  unit,
  label,
}: {
  slices: readonly RingSlice[];
  total: string;
  unit: string;
  label: string;
}) {
  const [pointed, setPointed] = useState<string | null>(null);
  const shown = slices.filter((slice) => slice.value > 0);
  const gap = shown.length > 1 ? GAP : 0;
  // Each slice starts where the ones before it end.
  const arcs = shown.map((slice, i) => {
    const offset = shown.slice(0, i).reduce((sum, before) => sum + before.share * CIRCUMFERENCE, 0);
    return { slice, length: Math.max(0.5, slice.share * CIRCUMFERENCE - gap), offset };
  });
  const active = shown.find((slice) => slice.key === pointed) ?? null;
  return (
    <div className="relative size-40 shrink-0" data-status-ring="">
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="size-full -rotate-90 overflow-visible"
        role="img"
        aria-label={`${label}: ${shown.map((slice) => `${slice.label} ${percent(slice.share)}`).join(", ")}`}
      >
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={WIDTH}
          className="stroke-raised"
        />
        {arcs.map(({ slice, length, offset }) => {
          const circle = (
            <circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke={slice.color}
              strokeWidth={active?.key === slice.key ? POINTED_WIDTH : WIDTH}
              strokeDasharray={`${length} ${CIRCUMFERENCE - length}`}
              strokeDashoffset={-offset}
              className={cn(
                "transition-[stroke-width] duration-200 motion-reduce:transition-none",
                slice.href && "cursor-pointer",
              )}
            />
          );
          const point = {
            onMouseEnter: () => setPointed(slice.key),
            onMouseLeave: () => setPointed(null),
            onFocus: () => setPointed(slice.key),
            onBlur: () => setPointed(null),
          };
          return slice.href ? (
            <Link
              key={slice.key}
              href={slice.href}
              aria-label={`${slice.label}: ${percent(slice.share)}`}
              className="outline-none"
              data-status-ring-slice={slice.key}
              {...point}
            >
              {circle}
            </Link>
          ) : (
            <g
              key={slice.key}
              tabIndex={0}
              aria-label={`${slice.label}: ${percent(slice.share)}`}
              className="outline-none"
              data-status-ring-slice={slice.key}
              {...point}
            >
              {circle}
            </g>
          );
        })}
      </svg>
      <div
        className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center"
        aria-live="polite"
        data-status-ring-middle=""
      >
        {active ? (
          <>
            <span className="text-2xl font-semibold text-fg tabular-nums">
              {percent(active.share)}
            </span>
            <span className="text-xs leading-tight text-fg-muted">{active.label}</span>
          </>
        ) : (
          <>
            <span className="text-2xl font-semibold text-fg tabular-nums">{total}</span>
            <span className="text-xs text-fg-subtle">{unit}</span>
          </>
        )}
      </div>
    </div>
  );
}
