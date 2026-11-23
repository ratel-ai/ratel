/**
 * A best-effort, in-process fixed-window counter for the Playground's uncharged
 * embedding calls.
 *
 * Deliberately NOT a distributed limiter: the thing it guards is a per-user
 * convenience on the server's own provider credential, already behind session
 * auth and a feature flag, and every request is additionally bounded by hard
 * input caps. Per-instance counting can therefore be off by the instance count
 * under a fan-out, which is an acceptable ceiling for that exposure. It is a
 * blast-radius cap, not an accounting boundary. Anything that needs to be exact
 * (real metering, billing) must not be built on this.
 */

export interface QuotaDecision {
  allowed: boolean;
  remaining: number;
  /** When the current window resets, epoch ms. */
  resetAt: number;
}

interface Window {
  count: number;
  resetAt: number;
}

export interface FixedWindowQuota {
  consume(key: string, cost?: number): QuotaDecision;
}

/**
 * `limit` units per `windowMs`, counted per key. Windows are lazily created and
 * swept on write, so an idle process does not accumulate entries forever.
 */
export function createFixedWindowQuota(
  limit: number,
  windowMs: number,
  now: () => number = Date.now,
): FixedWindowQuota {
  const windows = new Map<string, Window>();

  function sweep(at: number): void {
    for (const [key, window] of windows) {
      if (window.resetAt <= at) windows.delete(key);
    }
  }

  return {
    consume(key, cost = 1) {
      const at = now();
      sweep(at);
      const existing = windows.get(key);
      const window: Window = existing ?? { count: 0, resetAt: at + windowMs };
      if (window.count + cost > limit) {
        windows.set(key, window);
        return {
          allowed: false,
          remaining: Math.max(0, limit - window.count),
          resetAt: window.resetAt,
        };
      }
      const updated: Window = { ...window, count: window.count + cost };
      windows.set(key, updated);
      return {
        allowed: true,
        remaining: limit - updated.count,
        resetAt: updated.resetAt,
      };
    },
  };
}
