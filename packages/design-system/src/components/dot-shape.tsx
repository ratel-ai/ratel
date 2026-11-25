// biome-ignore-all lint/suspicious/noArrayIndexKey: a fixed list of layers, never reordered.
"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { cn } from "../cn";
import { DOT_SHAPES, type DotShapeName, dotLayers } from "./dot-shape-model";

/** A dot and its gap, as in `DotSpark`. */
const CELL_PX = 6;

/**
 * A picture of what a place will hold, for a place that has nothing yet: its dots dissolve into
 * noise and form again, a few times, and then it rests formed. It means "not here yet" and never
 * "loading": it has no direction, no progress, and it stops.
 *
 * It runs while it is on screen, again on hover or focus of the nearest `data-dot-shape-replay`,
 * and never with reduced motion or in an inert part of the page. Decoration: say the same in words.
 * It fits its container (`container-type: size`), at most at the scale of the other dots.
 */
export function DotShape({
  name,
  startMs = 0,
  className,
}: {
  name: DotShapeName;
  /** Waits this long, so that several on one page do not turn together. */
  startMs?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
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
    const place = element.closest("[data-dot-shape-replay]");
    place?.addEventListener("pointerenter", again);
    place?.addEventListener("focusin", again);
    return () => {
      observer.disconnect();
      place?.removeEventListener("pointerenter", again);
      place?.removeEventListener("focusin", again);
    };
  }, []);
  const { width, rows } = DOT_SHAPES[name];
  return (
    <span
      ref={ref}
      aria-hidden="true"
      className={cn("relative block", className)}
      style={{
        aspectRatio: `${width} / ${rows.length}`,
        width: `min(${width * CELL_PX}px, 100cqw, ${((width / rows.length) * 100).toFixed(2)}cqh)`,
      }}
      data-dot-shape={name}
      data-dot-shape-run={run === 0 ? undefined : shown ? "on" : "paused"}
    >
      {dotLayers(name).map(({ kind, path, noise, formed, shimmer, delayMs }, at) => (
        <svg
          // A new run is a new element, which is what starts a CSS animation again.
          key={`${run}:${at}`}
          aria-hidden="true"
          viewBox={`-0.5 -0.5 ${width} ${rows.length}`}
          className={cn(
            "dot-shape-layer absolute inset-0 size-full",
            kind === "shape" ? "text-fg-muted" : "text-fg-faint",
          )}
          style={
            {
              "--dot-noise": noise,
              "--dot-formed": formed,
              "--dot-shimmer": shimmer,
              "--dot-delay": `${startMs + delayMs}ms`,
            } as CSSProperties
          }
        >
          <path d={path} stroke="currentColor" strokeWidth={0.66} strokeLinecap="square" />
        </svg>
      ))}
    </span>
  );
}
