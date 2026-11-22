/**
 * Fixed-size bitsets over turn indices, the miner's support sets. A set of
 * 50k turns is 6.25 KB, and intersecting two is a few thousand word ANDs, so
 * support counting stays linear in turns / 32 rather than in turns.
 *
 * The builders below write only into arrays they just allocated; nothing
 * passed in is ever changed, except by {@link setBit}, which the callers use
 * on bitsets they own while building them.
 */

export type Bitset = Uint32Array;

export function emptyBitset(size: number): Bitset {
  return new Uint32Array((size + 31) >>> 5);
}

/** Sets bit `index` of a bitset the caller is still building. */
export function setBit(bits: Bitset, index: number): void {
  bits[index >>> 5] |= 1 << (index & 31);
}

export function hasBit(bits: Bitset, index: number): boolean {
  return (bits[index >>> 5]! & (1 << (index & 31))) !== 0;
}

function pop32(word: number): number {
  const a = word - ((word >>> 1) & 0x55555555);
  const b = (a & 0x33333333) + ((a >>> 2) & 0x33333333);
  return Math.imul((b + (b >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

export function popcount(bits: Bitset): number {
  let total = 0;
  for (let i = 0; i < bits.length; i++) total += pop32(bits[i]!);
  return total;
}

/** A new bitset holding `a AND b`. */
export function intersect(a: Bitset, b: Bitset): Bitset {
  const out = new Uint32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! & b[i]!;
  return out;
}

/** The number of bits in `bits` that are not in `mask`. */
export function popcountAndNot(bits: Bitset, mask: Bitset): number {
  let total = 0;
  for (let i = 0; i < bits.length; i++) total += pop32(bits[i]! & ~mask[i]!);
  return total;
}

/** A new bitset holding `a OR b`. */
export function union(a: Bitset, b: Bitset): Bitset {
  const out = new Uint32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! | b[i]!;
  return out;
}

/** The indices set in `bits` and not in `mask`, ascending. */
export function indicesAndNot(bits: Bitset, mask: Bitset): number[] {
  const out: number[] = [];
  for (let w = 0; w < bits.length; w++) {
    let word = bits[w]! & ~mask[w]!;
    while (word !== 0) {
      const low = word & -word;
      out.push(w * 32 + (31 - Math.clz32(low)));
      word ^= low;
    }
  }
  return out;
}

/** A new bitset with the given indices set. */
export function bitsetOf(size: number, indices: Iterable<number>): Bitset {
  const out = emptyBitset(size);
  for (const index of indices) setBit(out, index);
  return out;
}
