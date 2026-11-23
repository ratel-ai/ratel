"use client";

import { type KeyboardEvent, type RefObject, useEffect, useMemo, useState } from "react";
import type { JourneyLayout } from "@/lib/views/health/flow-journey-layout";

/**
 * The journey map's horizontal scroll: where each column snaps to, what the
 * "next" and "back" affordances say, keyboard steps, and the reveal of
 * columns as they scroll into view.
 *
 * A column snaps so it lines up just right of the pinned start rail. The next
 * affordance names the first column not yet fully in view, and a press moves
 * one column. Arrow keys on the focused map do the same; past the last column
 * the right arrow unfolds the next call (`onPastEnd`). Home and End go to
 * either end. Columns that start out of view fade and slide in the first time
 * they enter it; under reduced motion they are simply there.
 */

/** The start rail pinned at the left once the map is scrolled. */
export const JOURNEY_RAIL_WIDTH = 76;
/** The map's offset from the top of its panel (the scroller's top padding). */
export const JOURNEY_MAP_TOP = 12;

export interface ScrollStop {
  left: number;
  label: string;
}

export interface ScrollView {
  left: number;
  width: number;
  max: number;
}

export interface JourneyScroll {
  view: ScrollView;
  /** Whether the start rail is showing: the real start column has scrolled out of view. */
  scrolled: boolean;
  next: ScrollStop | null;
  prev: ScrollStop | null;
  goTo: (left: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

export function reducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Where each column after the start snaps to, and its title. */
export function scrollStops(layout: JourneyLayout): ScrollStop[] {
  return [
    { left: 0, label: layout.columns[0]?.title ?? "Start" },
    ...layout.columns.slice(1).map((column) => ({
      left: Math.max(0, Math.round(column.x - JOURNEY_RAIL_WIDTH - 8)),
      label: column.title,
    })),
  ];
}

/**
 * Whether the pinned rail should show: only once the real start column is
 * out of view, so the two never sit on top of each other half-scrolled.
 */
export function railShows(layout: JourneyLayout, left: number): boolean {
  const start = layout.columns[0];
  return !!start && left > start.x + start.width - 6;
}

export interface JourneyScrollOptions {
  /**
   * Whether columns out of view fade in as they scroll in. Off for a map that
   * must draw complete (the prerequisites view): any column still waiting is
   * shown at once.
   */
  reveal?: boolean;
}

export function useJourneyScroll(
  scroller: RefObject<HTMLDivElement | null>,
  layout: JourneyLayout,
  onPastEnd: () => void,
  { reveal = true }: JourneyScrollOptions = {},
): JourneyScroll {
  const stops = useMemo(() => scrollStops(layout), [layout]);
  const [view, setView] = useState<ScrollView>({ left: 0, width: 0, max: 0 });

  // Measured on scroll, and whenever the scroller or the drawing in it changes size
  // (a resize, an expanded or unfolded column); the observer also reports once on start.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        setView({
          left: el.scrollLeft,
          width: el.clientWidth,
          max: el.scrollWidth - el.clientWidth,
        }),
      );
    };
    el.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    if (el.firstElementChild) observer?.observe(el.firstElementChild);
    if (!observer) measure();
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [scroller]);

  // Columns out of view at first reveal themselves as they scroll in.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (!reveal) {
      for (const part of el.querySelectorAll("[data-reveal]"))
        part.setAttribute("data-reveal", "shown");
      return;
    }
    if (reducedMotion() || typeof IntersectionObserver !== "function") return;
    const right = el.getBoundingClientRect().right;
    const parts = [
      ...el.querySelectorAll<SVGGElement>("[data-journey-col], [data-journey-gap]"),
    ].filter(
      (part) =>
        part.getAttribute("data-reveal") !== "shown" && part.getBoundingClientRect().left > right,
    );
    if (parts.length === 0) return;
    for (const part of parts) part.setAttribute("data-reveal", "pending");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute("data-reveal", "shown");
          observer.unobserve(entry.target);
        }
      },
      { root: el, threshold: 0.05 },
    );
    for (const part of parts) observer.observe(part);
    return () => observer.disconnect();
  }, [scroller, layout.depth, layout.calls, reveal]);

  const goTo = (left: number) => {
    scroller.current?.scrollTo({ left, behavior: reducedMotion() ? "auto" : "smooth" });
  };

  const hiddenRight = layout.columns.find(
    (column) => column.x + column.width > view.left + view.width + 1,
  );
  const next =
    view.left < view.max - 1 && hiddenRight
      ? {
          left: stops.find((stop) => stop.left > view.left + 4)?.left ?? view.max,
          label: hiddenRight.title,
        }
      : null;
  const back = [...stops].reverse().find((stop) => stop.left < view.left - 4);
  const prev = view.left > 1 && back ? back : null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "ArrowRight" && !next) {
      event.preventDefault();
      onPastEnd();
      return;
    }
    const moves: Record<string, number | null | undefined> = {
      ArrowRight: next?.left,
      ArrowLeft: prev?.left,
      Home: 0,
      End: view.max,
    };
    const left = moves[event.key];
    if (left === undefined) return;
    event.preventDefault();
    if (left !== null) goTo(left);
  };

  return { view, scrolled: railShows(layout, view.left), next, prev, goTo, onKeyDown };
}
