import { wilsonInterval } from "@/lib/readings/stats";
import type { Interval } from "@/lib/readings/trace-signals/view";

/**
 * The statistics every detector shares: Wilson bounds (severity is always one),
 * quantiles over small samples, and a deterministic reservoir so a run over a
 * busy project keeps bounded memory and still gives the same answer twice.
 */

/** 95% Wilson interval for `k` of `n`, or null when `n` is 0. */
export function wilson(k: number, n: number): Interval | null {
  return wilsonInterval(k, n);
}

/** Lower Wilson bound for `k` of `n`; 0 when `n` is 0. */
export function wilsonLow(k: number, n: number): number {
  return wilsonInterval(k, n)?.low ?? 0;
}

/** Upper Wilson bound for `k` of `n`; 1 when `n` is 0 (nothing is ruled out). */
export function wilsonHigh(k: number, n: number): number {
  return wilsonInterval(k, n)?.high ?? 1;
}

/** The `q` quantile (0..1) of `values` by nearest rank; null when empty. */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[rank] ?? null;
}

export function median(values: readonly number[]): number | null {
  return quantile(values, 0.5);
}

/** A 32-bit FNV-1a hash, to seed a reservoir from a stable string. */
export function seedOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: a tiny deterministic PRNG in [0, 1). */
function nextRandom(state: { seed: number }): number {
  state.seed = (state.seed + 0x6d2b79f5) >>> 0;
  let t = state.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
}

/**
 * Algorithm R reservoir sampling with a seeded generator: a uniform sample of at
 * most `capacity` items from a stream of any length, identical for the same
 * stream and seed. The one mutable structure the accumulators use; it never
 * leaves them except through {@link Reservoir.values}.
 */
export class Reservoir<T> {
  private readonly items: T[] = [];
  private readonly state: { seed: number };
  private seen = 0;

  constructor(
    private readonly capacity: number,
    seed: number | string,
  ) {
    this.state = { seed: typeof seed === "string" ? seedOf(seed) : seed >>> 0 };
  }

  add(item: T): void {
    this.seen += 1;
    if (this.items.length < this.capacity) {
      this.items.push(item);
      return;
    }
    const slot = Math.floor(nextRandom(this.state) * this.seen);
    if (slot < this.capacity) this.items[slot] = item;
  }

  /** Items offered so far, including the ones not kept. */
  get total(): number {
    return this.seen;
  }

  values(): readonly T[] {
    return [...this.items];
  }
}
