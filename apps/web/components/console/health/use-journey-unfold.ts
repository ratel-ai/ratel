"use client";

import { type RefObject, useEffect, useRef } from "react";
import type { ScrollView } from "@/components/console/health/use-journey-scroll";
import { JOURNEY_VISIBLE_CALLS, type JourneyLayout } from "@/lib/views/health/flow-journey-layout";

/**
 * Later calls unfold as the reader scrolls. At rest the map draws three calls
 * and folds the rest into one "Later" column, so it fits its card. Pushing
 * past the right edge (a sideways wheel or trackpad swipe, shift and wheel, a
 * swipe on a phone, the right arrow key, or a click on "Later") unfolds one
 * more call and glides it into view. Scrolling back folds them away again:
 * a call column that has fully left the right edge folds back into "Later",
 * and returning to the start folds everything back to three.
 */

/** Sideways pushes closer together than this unfold one call, not several. */
const UNFOLD_EVERY_MS = 420;
/** A phone swipe must travel this far past the end to unfold. */
const SWIPE_PX = 40;
/** Back at the start, the map folds once scrolling has settled this long. */
const SETTLE_MS = 260;

export interface JourneyUnfoldOptions {
  scroller: RefObject<HTMLDivElement | null>;
  layout: JourneyLayout;
  view: ScrollView;
  setDepth: (depth: number) => void;
  /** Unfolds the next call (and glides it into view). */
  unfold: () => void;
  /** Off, nothing folds or unfolds on scroll: the map drawn is complete (the prerequisites view). */
  enabled?: boolean;
}

/** Whether a push past the right edge may unfold another call. Never when unfolding is off. */
export function canUnfoldMore(
  layout: Pick<JourneyLayout, "depth" | "calls">,
  enabled: boolean,
): boolean {
  return enabled && layout.depth < layout.calls;
}

/**
 * Where scrolling back folds the map to, and after how long, or null to leave
 * it be: back at the start, everything folds to three calls once scrolling
 * settles; a last call column that has left the right edge folds at once.
 * Never when unfolding is off.
 */
export function foldBackTo(
  layout: Pick<JourneyLayout, "depth" | "columns">,
  view: Pick<ScrollView, "left" | "width">,
  enabled: boolean,
): { depth: number; after: number } | null {
  if (!enabled || layout.depth <= JOURNEY_VISIBLE_CALLS || view.width === 0) return null;
  if (view.left <= 2) return { depth: JOURNEY_VISIBLE_CALLS, after: SETTLE_MS };
  const lastCall = layout.columns[layout.depth];
  if (lastCall && lastCall.x > view.left + view.width + 8)
    return { depth: layout.depth - 1, after: 0 };
  return null;
}

/** Wires the gestures that unfold later calls and the scroll positions that fold them back. */
export function useJourneyUnfold({
  scroller,
  layout,
  view,
  setDepth,
  unfold,
  enabled = true,
}: JourneyUnfoldOptions): void {
  const canUnfold = canUnfoldMore(layout, enabled);
  const latest = useRef({ canUnfold, unfold: () => {} });

  useEffect(() => {
    latest.current = { canUnfold, unfold };
  });

  // Sideways pushes at the right end, and phone swipes past it.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let last = 0;
    let touchX: number | null = null;
    let swiped = false;
    const atEnd = () => el.scrollLeft >= el.scrollWidth - el.clientWidth - 2;
    const push = () => {
      const now = performance.now();
      if (now - last < UNFOLD_EVERY_MS) return;
      last = now;
      latest.current.unfold();
    };
    const onWheel = (event: WheelEvent) => {
      const sideways = event.shiftKey ? event.deltaY || event.deltaX : event.deltaX;
      const isSideways = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.5;
      if (!isSideways || sideways <= 4 || !atEnd() || !latest.current.canUnfold) return;
      event.preventDefault();
      push();
    };
    const onTouchStart = (event: TouchEvent) => {
      touchX = event.touches[0]?.clientX ?? null;
      swiped = false;
    };
    const onTouchMove = (event: TouchEvent) => {
      const x = event.touches[0]?.clientX;
      if (touchX === null || x === undefined || swiped || !atEnd() || !latest.current.canUnfold)
        return;
      if (touchX - x > SWIPE_PX) {
        swiped = true;
        push();
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, [scroller]);

  // Folding back as the reader scrolls left.
  useEffect(() => {
    const fold = foldBackTo(layout, view, enabled);
    if (!fold) return;
    const timer = setTimeout(() => setDepth(fold.depth), fold.after);
    return () => clearTimeout(timer);
  }, [enabled, layout, view, setDepth]);
}
