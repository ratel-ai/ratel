import { indexClusters, MEMBER_CAP } from "@/lib/readings/intent-engine/engine";
import {
  COMPACT_SETTLE_MS,
  compactIntents,
  SUPPORT_FULL,
} from "@/lib/readings/intent-graph/compact";
import type {
  EngineCluster,
  EngineMerge,
  SourceSlice,
} from "@/lib/readings/intent-types/engine-types";

/**
 * Compaction for the engine's clusters, run at the end of every engine job.
 *
 * Two lanes:
 *   - **Edge lane**: clusters a runtime is served, merged by the
 *     adaptive-ranking pass itself (`compactIntents` in
 *     `lib/intent-graph/compact.ts`): same gates, same settle time, so a served
 *     graph compacts exactly as it does today.
 *   - **Wording lane**: clusters with no served edges (asks nothing answered,
 *     user messages) have no edge to agree on, so the edge lane skips them. A
 *     settled fragment here joins the cluster whose wording it restates, under
 *     a stricter bar than a live match (`EDGELESS_TAU`), because no tool backs it.
 *
 * Both lanes absorb only small (`support`/`asks` below `SUPPORT_FULL`), quiet
 * fragments into a survivor, never through a third cluster.
 */

/** Symmetric wording an edgeless fragment needs with its survivor. */
export const EDGELESS_TAU = 0.75;

export interface EngineCompactionOptions {
  settleMs?: number;
  edgelessTau?: number;
}

export interface EngineCompaction {
  clusters: EngineCluster[];
  merges: EngineMerge[];
}

export function compactEngine(
  clusters: readonly EngineCluster[],
  now: number,
  options: EngineCompactionOptions = {},
): EngineCompaction {
  const settleMs = options.settleMs ?? COMPACT_SETTLE_MS;
  const merges: EngineMerge[] = [];

  // Edge lane: the adaptive-ranking pass over the served clusters.
  const served = clusters.filter(isServed);
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const edged = compactIntents(served, now, { settleMs });
  const absorbed = new Set<string>();
  const merged = new Map<string, EngineCluster>();
  for (const out of edged.intents) merged.set(out.uuid, out);
  for (const group of edged.groups) {
    const survivor = merged.get(byId.get(group.survivor)!.uuid)!;
    for (const id of group.absorbed) {
      const gone = byId.get(id)!;
      absorbed.add(gone.uuid);
      merges.push(mergeOf(gone, survivor));
      foldExtras(survivor, gone);
    }
    survivor.dirty = true;
  }
  let current = clusters.filter((c) => !absorbed.has(c.uuid)).map((c) => merged.get(c.uuid) ?? c);

  // Wording lane: settled, small, unserved fragments into the cluster they restate.
  const tau = options.edgelessTau ?? EDGELESS_TAU;
  const settledBefore = now - settleMs;
  const fragments = current
    .filter(
      (c) =>
        !isServed(c) &&
        c.asks < SUPPORT_FULL &&
        (settleMs === 0 || (c.last_ts ?? 0) <= settledBefore),
    )
    .sort((a, b) => a.asks - b.asks || a.id.localeCompare(b.id, "en", { numeric: true }));
  if (fragments.length > 0 && current.length > 1) {
    const index = indexClusters(current);
    const byUuid = new Map(current.map((c) => [c.uuid, c]));
    const gone = new Set<string>();
    const receiving = new Set<string>();
    for (const fragment of fragments) {
      if (gone.has(fragment.uuid) || receiving.has(fragment.uuid)) continue;
      let best: { uuid: string; wording: number } | null = null;
      for (const member of fragment.members) {
        for (const c of index.candidates(member, new Set())) {
          if (c.key === fragment.uuid || gone.has(c.key) || c.wording < tau) continue;
          const target = byUuid.get(c.key)!;
          // Only into a bigger cluster: a fragment never swallows its peer's survivor.
          if (target.asks < fragment.asks) continue;
          if (!best || c.wording > best.wording) best = { uuid: c.key, wording: c.wording };
        }
      }
      if (!best) continue;
      const survivor = byUuid.get(best.uuid)!;
      merges.push(mergeOf(fragment, survivor));
      absorbInto(survivor, fragment);
      gone.add(fragment.uuid);
      receiving.add(survivor.uuid);
    }
    current = current.filter((c) => !gone.has(c.uuid));
  }
  return { clusters: current, merges };
}

/** Whether a runtime is served this cluster: it has edges the learner credited. */
export function isServed(c: EngineCluster): boolean {
  return c.support > 0 && (Object.keys(c.tools).length > 0 || Object.keys(c.skills).length > 0);
}

function mergeOf(gone: EngineCluster, survivor: EngineCluster): EngineMerge {
  return {
    absorbedUuid: gone.uuid,
    survivorUuid: survivor.uuid,
    absorbedQueryIntentId: gone.queryIntentId,
  };
}

/** What `compactIntents` does not know to merge: Cloud's own fields. */
function foldExtras(survivor: EngineCluster, gone: EngineCluster) {
  survivor.servedMembers = mergeMembers(survivor.servedMembers, gone.servedMembers);
  survivor.asks += gone.asks;
  survivor.first_ts = Math.min(survivor.first_ts, gone.first_ts);
  survivor.usage = sumRecords(survivor.usage, gone.usage);
  for (const [sourceId, slice] of Object.entries(gone.sources)) {
    const mine = survivor.sources[sourceId];
    survivor.sources[sourceId] = mine ? mergeSlices(mine, slice) : slice;
  }
  survivor.queryIntentId ??= gone.queryIntentId;
}

/** Wording-lane merge: the fragment has no served edges, so only Cloud's fields move. */
function absorbInto(survivor: EngineCluster, gone: EngineCluster) {
  survivor.members = mergeMembers(survivor.members, gone.members);
  survivor.last_ts = Math.max(survivor.last_ts ?? 0, gone.last_ts ?? 0);
  foldExtras(survivor, gone);
  survivor.dirty = true;
}

function mergeSlices(a: SourceSlice, b: SourceSlice): SourceSlice {
  const out: SourceSlice = {
    graphId: a.graphId,
    support: a.support + b.support,
    members: mergeMembers(a.members, b.members),
    tools: sumRecords(a.tools, b.tools),
    skills: sumRecords(a.skills, b.skills),
  };
  const st = sumRecords(a.surfaced_tools ?? {}, b.surfaced_tools ?? {});
  const ss = sumRecords(a.surfaced_skills ?? {}, b.surfaced_skills ?? {});
  if (Object.keys(st).length > 0) out.surfaced_tools = st;
  if (Object.keys(ss).length > 0) out.surfaced_skills = ss;
  const last = Math.max(a.last_ts ?? 0, b.last_ts ?? 0);
  if (last > 0) out.last_ts = last;
  return out;
}

function mergeMembers(a: readonly string[], b: readonly string[]): string[] {
  const out = [...a];
  for (const m of b) if (!out.includes(m)) out.push(m);
  return out.length > MEMBER_CAP ? out.slice(out.length - MEMBER_CAP) : out;
}

function sumRecords(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}
