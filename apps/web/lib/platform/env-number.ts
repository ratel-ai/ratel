/**
 * A numeric tuning knob read from the environment: `fallback` when the variable is
 * unset, empty, not a finite number, or rejected by `valid` (default: strictly
 * positive). `env` is injectable for tests. Callers that need an integer floor the
 * result; callers with a range pass their own predicate.
 */
export function envNumber(
  name: string,
  fallback: number,
  valid: (n: number) => boolean = (n) => n > 0,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && valid(n) ? n : fallback;
}
