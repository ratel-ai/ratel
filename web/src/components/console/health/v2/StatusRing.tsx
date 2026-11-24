"use client";

import { useState } from "react";
import { RING_SIZE, RingArc, RingTrack, ringArcs } from "@/components/console/health/v2/ring";
import { percent } from "@/components/console/sentiment/copy";
import { RootCauseLink } from "@/components/console/sentiment/RootCausesHost";

/** One slice of the ring: its share of the whole, its colour (an SVG paint), and where it leads, if anywhere. */
interface RingSlice {
  key: string;
  label: string;
  value: number;
  share: number;
  color: string;
  href: string | null;
}

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
  const arcs = ringArcs(shown, (slice) => slice.share);
  const active = shown.find((slice) => slice.key === pointed) ?? null;
  return (
    <div className="relative size-40 shrink-0" data-status-ring="">
      <svg
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        className="size-full -rotate-90 overflow-visible"
        role="img"
        aria-label={`${label}: ${shown.map((slice) => `${slice.label} ${percent(slice.share)}`).join(", ")}`}
      >
        <RingTrack />
        {arcs.map(({ slice, length, offset }) => {
          const circle = (
            <RingArc
              key={slice.key}
              length={length}
              offset={offset}
              pointed={active?.key === slice.key}
              stroke={slice.color}
              className={slice.href ? "cursor-pointer" : undefined}
            />
          );
          const point = {
            onMouseEnter: () => setPointed(slice.key),
            onMouseLeave: () => setPointed(null),
            onFocus: () => setPointed(slice.key),
            onBlur: () => setPointed(null),
          };
          return slice.href ? (
            <RootCauseLink
              key={slice.key}
              href={slice.href}
              aria-label={`${slice.label}: ${percent(slice.share)}`}
              className="outline-none"
              data-status-ring-slice={slice.key}
              {...point}
            >
              {circle}
            </RootCauseLink>
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
            <span className="text-xs leading-tight text-fg-muted">
              {/* Lower case, like the unit at rest. */}
              {active.label.toLowerCase()}
            </span>
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
