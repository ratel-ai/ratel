"use client";

import { type CSSProperties, type RefObject, useEffect, useRef, useState } from "react";
import { cn } from "../cn";
import { maskImage, VEIL_SHAPES, type VeilShapeName } from "./veil-shape-model";

/** A cell of a picture, as the other dots of the brand. */
const CELL_PX = 6;

/**
 * A picture of what a place will hold, for a place that has nothing yet: the picture's cells, with
 * a warm light and dark folds drifting through them, after the Dark Veil of the sign-in page. It
 * means "not here yet", never "loading": it has no direction, no progress, and it stops after two
 * drifts.
 *
 * Plain markup and CSS, not the sign-in page's WebGL shader: that shader is React Bits code (MIT +
 * Commons Clause), and four of it cost several times the GPU time. The server draws it at rest,
 * and only a transform moves. It runs while it
 * is on screen, again on hover or focus of the nearest `data-veil-replay`, and never with reduced
 * motion or in an inert part of the page. Decoration: say the same in words. It fits its
 * container (`container-type: size`), at most at the scale of the other dots.
 */
export function VeilShape({
  name,
  startMs = 0,
  className,
}: {
  name: VeilShapeName;
  /** Waits this long, so that several on one page do not move together. */
  startMs?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const { run, shown } = useRun(ref);
  const { width, rows } = VEIL_SHAPES[name];
  return (
    <span
      ref={ref}
      aria-hidden="true"
      className={cn("veil-shape relative block", className)}
      style={
        {
          aspectRatio: `${width} / ${rows.length}`,
          width: `min(${width * CELL_PX}px, 100cqw, ${((width / rows.length) * 100).toFixed(2)}cqh)`,
          "--veil-mask": maskImage(name),
          "--veil-delay": `${startMs}ms`,
        } as CSSProperties
      }
      data-veil-shape={name}
      data-veil-run={run === 0 ? undefined : shown ? "on" : "paused"}
    >
      {/* A new run is a new element, which is what starts a CSS animation again. */}
      <span key={`glow-${run}`} className="veil-shape-glow" />
      <span key={`fold-${run}`} className="veil-shape-fold" />
      <span className="veil-shape-grain" />
    </span>
  );
}

/** Started when first on screen, paused off screen, and again on hover or focus once it stopped. */
function useRun(ref: RefObject<HTMLSpanElement | null>) {
  /** How many times it was started. 0: it was not on screen yet. */
  const [run, setRun] = useState(0);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      setShown(entry.isIntersecting);
      if (entry.isIntersecting) setRun((times) => times || 1);
    });
    observer.observe(element);
    const again = () => {
      if (element.getAnimations({ subtree: true }).length === 0) setRun((times) => times + 1);
    };
    const place = element.closest("[data-veil-replay]");
    place?.addEventListener("pointerenter", again);
    place?.addEventListener("focusin", again);
    return () => {
      observer.disconnect();
      place?.removeEventListener("pointerenter", again);
      place?.removeEventListener("focusin", again);
    };
  }, [ref]);
  return { run, shown };
}
