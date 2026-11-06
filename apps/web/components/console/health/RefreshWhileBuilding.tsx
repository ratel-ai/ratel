"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";

/** The wait before the n-th refresh: 5 s, then half as long again each time, 30 s at most. */
export function refreshDelayMs(n: number): number {
  return Math.min(30_000, Math.round(5_000 * 1.5 ** Math.max(0, n)));
}

/** How long the page keeps watching, counted in visible time: past a signal run's own time budget. */
export const REFRESH_FOR_MS = 15 * 60_000;

/**
 * While a reading is being built, the page reads itself again, sooner at
 * first and then less often, so it turns into the reading on its own. Only
 * while the tab is visible (hidden time does not count against the budget),
 * one refresh at a time, and for a while at most. Renders only a hidden
 * marker (`data-health-watching`).
 */
export function RefreshWhileBuilding({ forMs = REFRESH_FOR_MS }: { forMs?: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const pendingRef = useRef(false);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  useEffect(() => {
    let watchedMs = 0;
    let tick = 0;
    let timer: number | undefined;
    const schedule = () => {
      const delay = refreshDelayMs(tick);
      timer = window.setTimeout(() => {
        if (document.visibilityState === "visible") {
          watchedMs += delay;
          tick += 1;
          if (!pendingRef.current) startTransition(() => router.refresh());
        }
        if (watchedMs < forMs) schedule();
      }, delay);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [router, forMs]);

  return <span hidden data-health-watching="" />;
}
