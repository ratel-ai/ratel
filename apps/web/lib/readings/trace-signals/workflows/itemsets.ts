import { type Bitset, intersect, popcount } from "@/lib/readings/trace-signals/workflows/bitset";

/**
 * Level-wise (Apriori) frequent-itemset mining over tool bitsets.
 *
 * Tools are integer indices in id order, so an itemset is a sorted index list.
 * Level k+1 joins two level-k itemsets that share their first k-1 tools, keeps
 * the candidate only when every k-subset is frequent, and counts its support
 * by ANDing a parent's turn bitset with the added tool's. Bitsets make each
 * count O(turns / 32), whatever the support.
 *
 * Bounded by `maxCandidates`: when a level would overflow what is left of the
 * budget, its most-supported itemsets are kept, `truncated` is set and mining
 * stops (so every stored itemset's subsets are stored too, which the closed
 * and helper checks rely on).
 */

export interface Itemset {
  /** Tool indices, ascending. */
  items: readonly number[];
  key: string;
  support: number;
  bits: Bitset;
}

export interface Lattice {
  /** `levels[k]` holds the frequent itemsets of size k (index 0 is empty). */
  levels: readonly (readonly Itemset[])[];
  byKey: ReadonlyMap<string, Itemset>;
  /** Itemsets of size 2 and up. */
  count: number;
  truncated: boolean;
}

export interface LatticeLimits {
  floor: number;
  maxSize: number;
  maxCandidates: number;
}

export function itemsetKey(items: readonly number[]): string {
  return items.join(",");
}

function singletons(toolBits: readonly Bitset[], floor: number): Itemset[] {
  return toolBits.flatMap((bits, index) => {
    const support = popcount(bits);
    return support >= floor ? [{ items: [index], key: itemsetKey([index]), support, bits }] : [];
  });
}

function subsetsFrequent(items: readonly number[], byKey: ReadonlyMap<string, Itemset>): boolean {
  // The two parents (dropping either of the last two items) are frequent by construction.
  for (let drop = 0; drop < items.length - 2; drop++) {
    if (!byKey.has(itemsetKey(items.filter((_, i) => i !== drop)))) return false;
  }
  return true;
}

function groupByPrefix(level: readonly Itemset[]): Itemset[][] {
  const groups = new Map<string, Itemset[]>();
  for (const set of level) {
    const prefix = itemsetKey(set.items.slice(0, -1));
    groups.set(prefix, [...(groups.get(prefix) ?? []), set]);
  }
  return [...groups.values()];
}

function joinGroup(
  group: readonly Itemset[],
  toolBits: readonly Bitset[],
  byKey: ReadonlyMap<string, Itemset>,
  floor: number,
  out: Itemset[],
  limit: number,
): boolean {
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const left = group[i]!;
      const added = group[j]!.items[group[j]!.items.length - 1]!;
      const items = [...left.items, added];
      if (!subsetsFrequent(items, byKey)) continue;
      const bits = intersect(left.bits, toolBits[added]!);
      const support = popcount(bits);
      if (support < floor) continue;
      out.push({ items, key: itemsetKey(items), support, bits });
      if (out.length >= limit) return false;
    }
  }
  return true;
}

/** The next level, or a capped one with `complete` false. */
function nextLevel(
  level: readonly Itemset[],
  toolBits: readonly Bitset[],
  byKey: ReadonlyMap<string, Itemset>,
  floor: number,
  budget: number,
): { sets: Itemset[]; complete: boolean } {
  // Collect up to twice the budget, then keep the best supported, so a cap
  // does not simply keep whatever sorts first.
  const limit = budget * 2;
  const out: Itemset[] = [];
  for (const group of groupByPrefix(level)) {
    if (!joinGroup(group, toolBits, byKey, floor, out, limit)) break;
  }
  if (out.length <= budget) return { sets: out, complete: out.length < limit };
  const kept = [...out]
    .sort((a, b) => b.support - a.support || (a.key < b.key ? -1 : 1))
    .slice(0, budget);
  return { sets: kept, complete: false };
}

export function mineItemsets(toolBits: readonly Bitset[], limits: LatticeLimits): Lattice {
  const first = singletons(toolBits, limits.floor);
  const levels: Itemset[][] = [[], first];
  const byKey = new Map<string, Itemset>(first.map((set) => [set.key, set]));
  let count = 0;
  let truncated = false;
  for (let size = 2; size <= limits.maxSize && !truncated; size++) {
    const budget = limits.maxCandidates - count;
    if (budget <= 0) {
      truncated = levels[size - 1]!.length > 1;
      break;
    }
    const { sets, complete } = nextLevel(levels[size - 1]!, toolBits, byKey, limits.floor, budget);
    if (sets.length === 0) break;
    levels.push(sets);
    for (const set of sets) byKey.set(set.key, set);
    count += sets.length;
    truncated = !complete;
  }
  return { levels, byKey, count, truncated };
}
