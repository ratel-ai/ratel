export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;

/**
 * The wait before reconnect attempt `attempt` (0-based): an exponential ceiling
 * from 1 s to 60 s with jitter in its upper half, so a fleet of runners does not
 * reconnect in step after a gateway deploy. Always within 1 s and 60 s.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt));
  const jittered = ceiling * (0.5 + 0.5 * random());
  return Math.round(Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, jittered)));
}
