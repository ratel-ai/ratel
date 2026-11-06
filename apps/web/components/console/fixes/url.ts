import { usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { type FixFilters, parseFixFilters } from "@/lib/views/fixes/href";

/** A query string (with its `?`, or empty) with some parameters set or removed. */
export function withParams(
  search: string,
  changes: Readonly<Record<string, string | null>>,
): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  for (const [key, value] of Object.entries(changes)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * The list's filters from the URL (`?kind=`, `?task=`, `?tool=`, `?topic=`),
 * and a setter that writes them back. Each change is a history entry, so Back
 * undoes a filter; the History API keeps `useSearchParams` in sync without a
 * server round trip (the rows are already here).
 */
export function useFixFilters(): [
  FixFilters,
  (changes: Partial<Record<keyof FixFilters, string | null>>) => void,
  (changes: Partial<Record<keyof FixFilters, string | null>>) => string,
] {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = parseFixFilters(Object.fromEntries(searchParams.entries()));
  const hrefWith = useCallback(
    (changes: Partial<Record<keyof FixFilters, string | null>>) =>
      `${pathname}${withParams(searchParams.toString(), changes as Record<string, string | null>)}`,
    [pathname, searchParams],
  );
  const set = useCallback(
    (changes: Partial<Record<keyof FixFilters, string | null>>) => {
      window.history.pushState(
        null,
        "",
        `${pathname}${withParams(window.location.search, changes as Record<string, string | null>)}`,
      );
    },
    [pathname],
  );
  return [filters, set, hrefWith];
}
