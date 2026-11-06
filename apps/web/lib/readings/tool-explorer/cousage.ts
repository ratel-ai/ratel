import { envNumber } from "@/lib/platform/env-number";
import type {
  ExplorerScope,
  ExplorerSet,
  ExplorerSubject,
  ExplorerUnit,
  ExplorerWorkflowCore,
} from "@/lib/readings/tool-explorer/types";
import { Reservoir, wilsonLow } from "@/lib/readings/trace-signals/signals/severity";
import {
  bitsetOf,
  emptyBitset,
  indicesAndNot,
} from "@/lib/readings/trace-signals/workflows/bitset";
import { mineItemsets } from "@/lib/readings/trace-signals/workflows/itemsets";
import { workflowFingerprint } from "@/lib/readings/trace-signals/workflows/order";

/**
 * Co-used sets: frequent itemsets over each unit's distinct ids, mined with
 * Agent health's Apriori miner. A pair also carries its Jaccard (units with
 * both over units with either) and each direction's conditional share, which
 * is what tells "always together" from "often together": two tools the agent
 * never calls apart have a Jaccard near 1 from both sides.
 *
 * The population is the units with two or more distinct ids. The support
 * floor is the larger of a fixed count and a share of that population, so a
 * quiet project keeps a floor its sets can reach and a busy one is not
 * flooded.
 */

export const MIN_SET_SUPPORT = Math.floor(envNumber("TOOL_EXPLORER_MIN_SET_SUPPORT", 5));
export const MIN_SET_SHARE = envNumber("TOOL_EXPLORER_MIN_SET_SHARE", 0.01, (n) => n > 0 && n <= 1);
/** The largest co-used set by default; a run mines larger ones when a task is larger (`cousageSizeFor`). */
export const MAX_SET_SIZE = 4;
export const MAX_SET_CANDIDATES = Math.floor(envNumber("TOOL_EXPLORER_MAX_SET_CANDIDATES", 5_000));
const EXAMPLE_SESSIONS = 10;

export interface CousageOptions {
  minSupport?: number;
  minShare?: number;
  maxSize?: number;
  maxCandidates?: number;
  /** Tasks (Agent health workflows) to name a set after when its items are a task's core. */
  workflows?: readonly ExplorerWorkflowCore[];
}

export interface CousageResult {
  sets: ExplorerSet[];
  /** Units with at least one id. */
  units: number;
  /** Units with two or more distinct ids. */
  multiUnits: number;
  supportFloor: number;
  /** The miner hit `maxCandidates`. */
  truncated: boolean;
}

export function setKey(items: readonly string[]): string {
  return items.join("|");
}

export function supportFloor(multiUnits: number, minSupport: number, minShare: number): number {
  return Math.max(minSupport, Math.ceil(minShare * multiUnits));
}

export function mineCousage(
  scope: ExplorerScope,
  subject: ExplorerSubject,
  allUnits: readonly ExplorerUnit[],
  options: CousageOptions = {},
): CousageResult {
  const minSupport = options.minSupport ?? MIN_SET_SUPPORT;
  const minShare = options.minShare ?? MIN_SET_SHARE;
  const units = allUnits.filter((unit) => unit.items.length > 0);
  const multi = units.filter((unit) => unit.items.length >= 2);
  const floor = supportFloor(multi.length, minSupport, minShare);
  const base = {
    sets: [],
    units: units.length,
    multiUnits: multi.length,
    supportFloor: floor,
    truncated: false,
  };
  if (multi.length === 0) return base;

  const ids = [...new Set(multi.flatMap((unit) => unit.items))].sort();
  const indexOf = new Map(ids.map((id, index) => [id, index]));
  const membersOf: number[][] = ids.map(() => []);
  multi.forEach((unit, index) => {
    for (const id of unit.items) membersOf[indexOf.get(id)!]!.push(index);
  });
  const bits = membersOf.map((members) => bitsetOf(multi.length, members));
  // A pair's shares are relative to every unit that called the tool, single-call
  // units included: a tool mostly run alone is not "always with" its rare partner.
  const unitsOf = new Map<string, number>();
  for (const unit of units)
    for (const id of unit.items) unitsOf.set(id, (unitsOf.get(id) ?? 0) + 1);
  const lattice = mineItemsets(bits, {
    floor,
    maxSize: options.maxSize ?? MAX_SET_SIZE,
    maxCandidates: options.maxCandidates ?? MAX_SET_CANDIDATES,
  });
  const workflowByCore = new Map(
    (options.workflows ?? []).map((w) => [workflowFingerprint(w.coreTools), w.id]),
  );
  const none = emptyBitset(multi.length);

  const sets: ExplorerSet[] = [];
  for (let size = 2; size < lattice.levels.length; size++) {
    for (const itemset of lattice.levels[size]!) {
      const items = itemset.items.map((index) => ids[index]!);
      const examples = new Reservoir<string>(EXAMPLE_SESSIONS, setKey(items));
      for (const index of indicesAndNot(itemset.bits, none)) examples.add(multi[index]!.sessionId);
      let pair: Pick<ExplorerSet, "jaccard" | "jaccardLow" | "pAb" | "pBa"> = {
        jaccard: null,
        jaccardLow: null,
        pAb: null,
        pBa: null,
      };
      if (items.length === 2) {
        const unitsA = unitsOf.get(items[0]!)!;
        const unitsB = unitsOf.get(items[1]!)!;
        const either = unitsA + unitsB - itemset.support;
        pair = {
          jaccard: itemset.support / either,
          jaccardLow: wilsonLow(itemset.support, either),
          pAb: itemset.support / unitsA,
          pBa: itemset.support / unitsB,
        };
      }
      sets.push({
        scope,
        subject,
        key: setKey(items),
        items,
        size: items.length,
        support: itemset.support,
        share: itemset.support / units.length,
        ...pair,
        workflowId:
          subject === "tool" ? (workflowByCore.get(workflowFingerprint(items)) ?? null) : null,
        exampleSessions: [...new Set(examples.values())].sort(),
      });
    }
  }
  sets.sort((x, y) => y.support - x.support || x.size - y.size || (x.key < y.key ? -1 : 1));
  return { ...base, sets, truncated: lattice.truncated };
}
