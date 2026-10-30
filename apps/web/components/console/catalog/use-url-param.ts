"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { withQueryParams } from "@/lib/console/catalog/item-id";

/**
 * Query parameters as state (DESIGN.md, Everything is a URL). Writes go
 * through the History API, which Next keeps in sync with `useSearchParams`
 * without a server round trip, and replace rather than push, like `usePeek`,
 * so picking items or narrowing a list does not bury the previous page.
 */
export function useUrlWriter() {
  const pathname = usePathname();
  return useCallback(
    (patch: Readonly<Record<string, string | null>>) => {
      window.history.replaceState(
        null,
        "",
        `${pathname}${withQueryParams(window.location.search, patch)}`,
      );
    },
    [pathname],
  );
}

/** One query parameter as state, written at once. */
export function useUrlParam(
  param: string,
): readonly [string | null, (next: string | null) => void] {
  const searchParams = useSearchParams();
  const write = useUrlWriter();
  const set = useCallback((next: string | null) => write({ [param]: next }), [write, param]);
  return [searchParams.get(param), set] as const;
}

/** How long typing has to pause before the URL catches up. */
const SEARCH_WRITE_DELAY_MS = 250;

/**
 * A search box's text, mirrored into `?<param>=` once typing pauses. The input
 * reads local state, so it never lags; the URL is written at most once per
 * pause (Safari refuses more than about 100 History writes in 30 seconds).
 *
 * A URL change from elsewhere (a link to the same page, Back) replaces the
 * text; the echo of this hook's own write does not, so a letter typed while
 * the URL catches up is never lost. A pending write is dropped if the
 * parameter changed underneath it. `clear` names parameters that a new search
 * resets, such as the page.
 */
export function useSearchParamState(
  param: string,
  clear: readonly string[] = [],
): readonly [string, (next: string) => void] {
  const searchParams = useSearchParams();
  const write = useUrlWriter();
  const fromUrl = searchParams.get(param) ?? "";
  const [value, setValue] = useState(fromUrl);
  const [seen, setSeen] = useState(fromUrl);
  const [written, setWritten] = useState(fromUrl);
  if (fromUrl !== seen) {
    setSeen(fromUrl);
    if (fromUrl !== written) {
      setValue(fromUrl);
      setWritten(fromUrl);
    }
  }

  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const clearKey = clear.join("\n");
  const update = useCallback(
    (next: string) => {
      setValue(next);
      if (timer.current !== null) window.clearTimeout(timer.current);
      const base = new URLSearchParams(window.location.search).get(param) ?? "";
      timer.current = window.setTimeout(() => {
        timer.current = null;
        // Someone else moved the URL since this keystroke: theirs wins.
        if ((new URLSearchParams(window.location.search).get(param) ?? "") !== base) return;
        const stored = next.trim() === "" ? "" : next;
        setWritten(stored);
        const patch: Record<string, string | null> = { [param]: stored === "" ? null : stored };
        for (const name of clearKey === "" ? [] : clearKey.split("\n")) patch[name] = null;
        write(patch);
      }, SEARCH_WRITE_DELAY_MS);
    },
    [param, clearKey, write],
  );

  return [value, update] as const;
}
