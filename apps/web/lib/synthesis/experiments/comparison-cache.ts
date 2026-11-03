export interface ComparisonPageCacheOptions {
  /** How long a fetched page may be reused before telemetry counts as stale. */
  ttlMs: number;
  /** Hard bound on retained pages, so long browsing sessions can't grow. */
  maxEntries: number;
}

export interface ComparisonPageCache<T> {
  get(key: string, now: number): T | null;
  set(key: string, value: T, now: number): void;
  load(key: string, now: number, loader: () => Promise<T | null>): Promise<T | null>;
  clear(): void;
  size(): number;
}

/**
 * Tiny TTL + LRU cache for comparison-browser pages, so paging back to a page
 * the user already saw is instant instead of a second round trip. Time is a
 * parameter rather than a `Date.now()` call so eviction stays testable.
 *
 * Freshness comes from the key (it carries the project, experiment, window and
 * filter) plus the TTL; both together mean a cached page can only ever be a
 * slightly older read of the exact same query, never a different one.
 */
export function createComparisonPageCache<T>({
  ttlMs,
  maxEntries,
}: ComparisonPageCacheOptions): ComparisonPageCache<T> {
  // Map iteration order is insertion order: re-inserting on read/write keeps
  // the least recently used entry first.
  const entries = new Map<string, { value: T; storedAt: number }>();
  const inFlight = new Map<string, Promise<T | null>>();

  function get(key: string, now: number): T | null {
    const entry = entries.get(key);
    if (!entry) return null;
    entries.delete(key);
    if (now - entry.storedAt >= ttlMs) return null;
    entries.set(key, entry);
    return entry.value;
  }

  function set(key: string, value: T, now: number): void {
    entries.delete(key);
    entries.set(key, { value, storedAt: now });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  return {
    get,
    set,
    load(key, now, loader) {
      const cached = get(key, now);
      if (cached !== null) return Promise.resolve(cached);
      const pending = inFlight.get(key);
      if (pending) return pending;
      const request = loader()
        .then((loaded) => {
          if (loaded !== null) set(key, loaded, now);
          return loaded;
        })
        .finally(() => {
          if (inFlight.get(key) === request) inFlight.delete(key);
        });
      inFlight.set(key, request);
      return request;
    },
    clear() {
      entries.clear();
    },
    size() {
      return entries.size;
    },
  };
}
