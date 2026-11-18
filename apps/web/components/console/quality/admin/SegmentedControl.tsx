"use client";

import { cn } from "@ratel/design-system/cn";
import Link from "next/link";

/**
 * A one-of-N picker where the selection slides rather than blinks.
 *
 * Rendered as links, not buttons, because each option is a real URL: the window
 * and the calibration belong in the address bar so a view can be shared and the
 * back button works. The animation is the only client-side part.
 *
 * The indicator is positioned by INDEX over equal-width segments rather than by
 * measuring the active element. Measurement needs a layout effect and a resize
 * observer, and gets the first paint wrong on a server-rendered page; equal
 * widths make the maths exact and cost nothing.
 */
export interface Segment {
  label: string;
  href: string;
  /** Secondary text under the label, such as the sample size. */
  meta?: string;
}

export function SegmentedControl({
  segments,
  activeIndex,
  ariaLabel,
}: {
  segments: readonly Segment[];
  activeIndex: number;
  ariaLabel: string;
}) {
  if (segments.length === 0) return null;
  const width = 100 / segments.length;

  return (
    <div
      className="q-segmented"
      role="group"
      aria-label={ariaLabel}
      style={{ ["--q-seg-count" as string]: segments.length }}
    >
      <span
        aria-hidden
        className="q-segmented-thumb"
        style={{
          width: `${width}%`,
          transform: `translateX(${Math.max(0, activeIndex) * 100}%)`,
        }}
      />
      {segments.map((segment, index) => (
        <Link
          key={segment.href}
          href={segment.href}
          scroll={false}
          aria-current={index === activeIndex ? "true" : undefined}
          className={cn("q-segmented-item", index === activeIndex && "is-active")}
        >
          <span className="q-segmented-label">{segment.label}</span>
          {segment.meta && <span className="q-segmented-meta">{segment.meta}</span>}
        </Link>
      ))}
    </div>
  );
}
