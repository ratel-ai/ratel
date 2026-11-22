import { createHash } from "node:crypto";

/**
 * A workflow's identity and its order.
 *
 * - The fingerprint hashes the sorted core tools, so the same core mined in
 *   another run, or from another lane, gets the same id.
 * - The typical order counts, for every pair of core tools, how many member
 *   turns first-called one before the other (the convention of `pairs.ts`:
 *   first calls only, a repeat does not reorder). Tools are then ranked by
 *   how many others they precede by majority (a Copeland ranking, which
 *   tolerates a cycle), ties by mean first-call position, then by id.
 */

const FINGERPRINT_HEX = 16;

export function workflowFingerprint(coreTools: readonly string[]): string {
  const sorted = [...coreTools].sort().join("\u0000");
  return createHash("sha256").update(sorted).digest("hex").slice(0, FINGERPRINT_HEX);
}

interface OrderCounts {
  /** `before.get(a).get(b)`: turns where a was first called before b. */
  before: Map<string, Map<string, number>>;
  positionSum: Map<string, number>;
  positionCount: Map<string, number>;
}

function countOrder(core: readonly string[], paths: readonly (readonly string[])[]): OrderCounts {
  const coreSet = new Set(core);
  const before = new Map(core.map((tool) => [tool, new Map<string, number>()]));
  const positionSum = new Map<string, number>();
  const positionCount = new Map<string, number>();
  for (const path of paths) {
    const inCore = path.filter((tool) => coreSet.has(tool));
    path.forEach((tool, index) => {
      if (!coreSet.has(tool)) return;
      positionSum.set(tool, (positionSum.get(tool) ?? 0) + index);
      positionCount.set(tool, (positionCount.get(tool) ?? 0) + 1);
    });
    for (let i = 0; i < inCore.length; i++) {
      const row = before.get(inCore[i]!)!;
      for (let j = i + 1; j < inCore.length; j++)
        row.set(inCore[j]!, (row.get(inCore[j]!) ?? 0) + 1);
    }
  }
  return { before, positionSum, positionCount };
}

/** Core tools in the order member turns usually call them. */
export function typicalOrder(
  core: readonly string[],
  paths: readonly (readonly string[])[],
): string[] {
  const { before, positionSum, positionCount } = countOrder(core, paths);
  const precedes = (a: string, b: string) => before.get(a)?.get(b) ?? 0;
  const wins = new Map(
    core.map((a) => [a, core.filter((b) => b !== a && precedes(a, b) > precedes(b, a)).length]),
  );
  const meanPosition = (tool: string) => {
    const n = positionCount.get(tool) ?? 0;
    return n > 0 ? (positionSum.get(tool) ?? 0) / n : Number.POSITIVE_INFINITY;
  };
  return [...core].sort(
    (a, b) =>
      wins.get(b)! - wins.get(a)! ||
      meanPosition(a) - meanPosition(b) ||
      (a < b ? -1 : a > b ? 1 : 0),
  );
}

/**
 * Of the member turns that ran every core tool, how many first-called them in
 * exactly the typical order. Turns missing a core tool are left out: a run
 * that stopped early says nothing about whether the order is fixed.
 */
export function orderStability(
  typical: readonly string[],
  paths: readonly (readonly string[])[],
): { runs: number; stable: number; share: number } {
  const coreSet = new Set(typical);
  const full = paths
    .map((path) => path.filter((tool) => coreSet.has(tool)))
    .filter((order) => order.length === typical.length);
  const stable = full.filter((order) => order.every((tool, i) => tool === typical[i])).length;
  return { runs: full.length, stable, share: full.length > 0 ? stable / full.length : 0 };
}
