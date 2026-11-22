/**
 * A seeded percentile bootstrap for any statistic of a sample (RC-870): latency
 * percentiles and cost per successful trace, where no closed-form interval fits.
 * Seeded so the same traces always publish the same interval. Pure, no I/O.
 */

export const BOOTSTRAP_ITERATIONS = 1_000;

/**
 * A 95% percentile interval of `statistic` over `items`, resampled with
 * replacement. Resamples where the statistic is undefined (null) are dropped;
 * null when none is defined.
 */
export function bootstrapInterval<T>(
  items: readonly T[],
  statistic: (sample: readonly T[]) => number | null,
  seed: string,
  iterations: number = BOOTSTRAP_ITERATIONS,
): { low: number; high: number } | null {
  if (items.length === 0) return null;
  const random = mulberry32(hashSeed(seed));
  const values: number[] = [];
  const sample: T[] = new Array(items.length);
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (let draw = 0; draw < items.length; draw++)
      sample[draw] = items[Math.floor(random() * items.length)]!;
    const value = statistic(sample);
    if (value !== null && Number.isFinite(value)) values.push(value);
  }
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  return { low: percentile(values, 0.025), high: percentile(values, 0.975) };
}

/** The q-quantile of ascending `sorted` by linear interpolation (Postgres `percentile_cont`). */
export function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** FNV-1a over the seed text. */
function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
