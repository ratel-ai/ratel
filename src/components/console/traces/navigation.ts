"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useTransition } from "react";

/**
 * A new query string, or how to make one from the newest one asked for. The
 * function form builds on a navigation still loading, not on the page still
 * showing, so two quick changes both land.
 */
export type SearchUpdate = string | ((current: string) => string);

/**
 * Every filter, window and zoom change on a Traces page is a new query string
 * (DESIGN.md, Everything is a URL). Navigations run in one transition so the
 * page can hold its current render, dimmed, while the next one loads instead
 * of flashing a skeleton (data-viz: refetch keeps the frame).
 */
export function useTraceNavigation() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const search = searchParams.toString() ? `?${searchParams.toString()}` : "";
  // The query the newest navigation asked for. While one loads, the page
  // still shows the old query: a chip removed a moment ago must not come back
  // because the next change started from what is on screen.
  const requested = useRef(search);
  useEffect(() => {
    if (!pending) requested.current = search;
  }, [pending, search]);

  const go = useCallback(
    (next: SearchUpdate, options: { replace?: boolean } = {}) => {
      const nextSearch = typeof next === "function" ? next(requested.current) : next;
      requested.current = nextSearch;
      const href = `${pathname}${nextSearch}`;
      startTransition(() => {
        if (options.replace) router.replace(href, { scroll: false });
        else router.push(href, { scroll: false });
      });
    },
    [pathname, router],
  );

  /** Read the page again where it stands (a "Try again" after a read failed). */
  const refresh = useCallback(() => {
    startTransition(() => router.refresh());
  }, [router]);

  /** View state the server doesn't read (a column, the compare pick): no round trip. */
  const replaceView = useCallback(
    (nextSearch: string) => {
      window.history.replaceState(null, "", `${pathname}${nextSearch}`);
    },
    [pathname],
  );

  return { pathname, search, pending, go, refresh, replaceView };
}
