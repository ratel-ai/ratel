import { createHash } from "node:crypto";

/**
 * Seeded randomness for the Site Copilot demo. Every draw comes from a
 * mulberry32 stream keyed by a label, so one part of the plan (a
 * conversation, the lengths, the positions) never shifts another, and the
 * same seed always gives the same plan.
 */

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The first `length` hex characters of the label's SHA-256. */
export function hexOf(label: string, length: number): string {
  return createHash("sha256").update(label, "utf8").digest("hex").slice(0, length);
}

/** An independent stream for one label under one seed. */
export function rngFor(seed: number, label: string): Rng {
  return mulberry32(parseInt(hexOf(`${seed}:${label}`, 8), 16));
}

export const chance = (rng: Rng, p: number): boolean => rng() < p;

export const between = (rng: Rng, min: number, max: number): number => min + rng() * (max - min);

/** An integer in [min, max], both ends included. */
export const intBetween = (rng: Rng, min: number, max: number): number =>
  Math.floor(between(rng, min, max + 1));

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error("pick from an empty list");
  return items[Math.floor(rng() * items.length)]!;
}

/** One value, drawn in proportion to its weight. */
export function weighted<T>(rng: Rng, entries: ReadonlyArray<readonly [T, number]>): T {
  const total = entries.reduce((sum, [, weight]) => sum + Math.max(0, weight), 0);
  if (total <= 0) throw new Error("weighted draw with no positive weight");
  let r = rng() * total;
  for (const [value, weight] of entries) {
    r -= Math.max(0, weight);
    if (r < 0) return value;
  }
  return entries[entries.length - 1]![0];
}

/** A day of the month as people write it: 1st, 2nd, 3rd, 14th, 21st. */
export function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  const suffix = ["th", "st", "nd", "rd"][day % 10] ?? "th";
  return `${day}${day % 10 > 3 ? "th" : suffix}`;
}

/** A dollar amount rounded to the hundred: $48,300. */
export function dollars(amount: number): string {
  return `$${(Math.round(amount / 100) * 100).toLocaleString("en-US")}`;
}
