"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type LoopSignals,
  type LoopState,
  nextLoopState,
  pageIsVisible,
} from "@/lib/views/health/shape-loop-state";

export type { LoopState } from "@/lib/views/health/shape-loop-state";

export interface TurnShapesLoopProps {
  className?: string;
  children: ReactNode;
}

/**
 * The list of turn shapes. It runs its pictogram loops while someone can see
 * them, the list on screen and the tab visible, and pauses them otherwise so
 * they cost no frames. Everything it needs it observes after mount, so a hard
 * load, a client-side navigation, back and forward (including a bfcache
 * restore), a tab brought forward and a window switched back all start or
 * resume the loops the same way. The server render (and a failed script)
 * stays `idle`, the finished picture; a browser without IntersectionObserver
 * treats the list as on screen. The loops themselves are CSS, and reduced
 * motion keeps them off.
 */
export function TurnShapesLoop({ className, children }: TurnShapesLoopProps) {
  const ref = useRef<HTMLOListElement>(null);
  const [state, setState] = useState<LoopState>("idle");

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let signals: LoopSignals = {
      onScreen: typeof IntersectionObserver === "undefined",
      pageVisible: pageIsVisible(document),
    };
    const update = () => setState((current) => nextLoopState(current, signals));
    const onVisibility = () => {
      signals = { ...signals, pageVisible: pageIsVisible(document) };
      update();
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            signals = { ...signals, onScreen: entries.some((entry) => entry.isIntersecting) };
            update();
          });
    observer?.observe(node);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onVisibility);
    // Without an observer nothing else would call back: start on the next frame.
    const frame = observer ? 0 : requestAnimationFrame(update);
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onVisibility);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <ol ref={ref} className={className} data-loop={state}>
      {children}
    </ol>
  );
}
