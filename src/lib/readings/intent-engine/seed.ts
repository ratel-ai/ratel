import { randomUUID } from "node:crypto";
import { indexClusters, MEMBER_CAP } from "@/lib/readings/intent-engine/engine";
import { DEFAULT_THRESHOLDS } from "@/lib/readings/intent-engine/match";
import { cleanAskText, MEMBER_TEXT_MAX } from "@/lib/readings/intent-engine/text";
import type {
  EngineCluster,
  EngineState,
  SourceSlice,
} from "@/lib/readings/intent-types/engine-types";
import type { IntentGraphDocument, IntentGraphIntent } from "@/lib/readings/intent-types/wire";
import { splitMemberText } from "@/lib/readings/query-intents/member-text";

/**
 * The engine's first state for a project that already has history, from what
 * Cloud already learned of it:
 *
 *   - every cluster of the Cloud-built graph becomes an engine cluster with
 *     the same wire id, members and edges, so the engine's ids line up with
 *     the graph's should it ever serve one (deferred: ADR-0014);
 *   - each source's own graph is matched onto those clusters and kept as that
 *     source's slice, under the ids that source's graph used;
 *   - every recurring query intent (`query_intents`) is linked to the cluster
 *     that restates it, or becomes a cluster of its own.
 *
 * A seeded cluster's `asks` start at what its source counted; the breakdown
 * counts assignments, never `asks`, so a seed weighs clusters but adds no ask
 * to any Intent. Pure. Called once per project, before its first fold.
 */

export interface SeedInput {
  merged: IntentGraphDocument | null;
  bySource: ReadonlyMap<string, IntentGraphDocument>;
  queryIntents: ReadonlyArray<{
    id: string;
    text: string;
    memberText: string;
    occurrences: number;
  }>;
  now: number;
}

export function seedState(input: SeedInput): EngineState {
  const clusters: EngineCluster[] = [];
  let maxN = -1;
  const noteId = (id: string) => {
    const m = /^intent_(\d+)$/.exec(id);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  };

  for (const intent of input.merged?.intents ?? []) {
    noteId(intent.id);
    clusters.push(fromWire(intent, input.now));
  }

  // A source's clusters land on the merged cluster they restate.
  for (const [sourceId, doc] of [...input.bySource].sort(([a], [b]) => a.localeCompare(b))) {
    const index = indexClusters(clusters);
    const byUuid = new Map(clusters.map((c) => [c.uuid, c]));
    for (const intent of doc.intents) {
      noteId(intent.id);
      const slice = sliceFromWire(intent);
      const target = bestMatch(index, intent.members, byUuid, (c) => !(sourceId in c.sources));
      if (target) {
        target.sources[sourceId] = slice;
        continue;
      }
      const cluster = fromWire(intent, input.now);
      cluster.id = `intent_${++maxN}`;
      cluster.sources[sourceId] = slice;
      clusters.push(cluster);
      index.add({
        key: cluster.uuid,
        members: cluster.members,
        usage: cluster.usage,
        rank: clusters.length,
      });
      byUuid.set(cluster.uuid, cluster);
    }
  }

  // Recurring asks: linked to the cluster that restates them, or a cluster of their own.
  const index = indexClusters(clusters);
  const byUuid = new Map(clusters.map((c) => [c.uuid, c]));
  for (const row of input.queryIntents) {
    const phrases = [row.text, ...splitMemberText(row.memberText)]
      .map((p) => cleanAskText(p, MEMBER_TEXT_MAX))
      .filter((p) => p.length > 0);
    if (phrases.length === 0) continue;
    const target = bestMatch(index, phrases, byUuid, (c) => c.queryIntentId === null);
    if (target) {
      target.queryIntentId = row.id;
      target.asks += row.occurrences;
      continue;
    }
    const cluster: EngineCluster = {
      uuid: randomUUID(),
      id: `intent_${++maxN}`,
      label: phrases[0],
      terms: [],
      members: [...new Set(phrases)].slice(0, MEMBER_CAP),
      servedMembers: [],
      support: 0,
      asks: row.occurrences,
      first_ts: input.now,
      last_ts: input.now,
      tools: {},
      skills: {},
      usage: {},
      sources: {},
      queryIntentId: row.id,
      dirty: true,
    };
    clusters.push(cluster);
    byUuid.set(cluster.uuid, cluster);
    index.add({
      key: cluster.uuid,
      members: cluster.members,
      usage: cluster.usage,
      rank: clusters.length,
    });
  }

  return { clusters, nextGraphN: maxN + 1 };
}

function fromWire(intent: IntentGraphIntent, now: number): EngineCluster {
  const usage: Record<string, number> = {};
  for (const [id, n] of Object.entries(intent.tools)) usage[`tool:${id}`] = n;
  for (const [id, n] of Object.entries(intent.skills)) usage[`skill:${id}`] = n;
  const cluster: EngineCluster = {
    uuid: randomUUID(),
    id: intent.id,
    label: intent.label,
    terms: [...intent.terms],
    members: [...intent.members],
    servedMembers: [...intent.members],
    support: intent.support,
    asks: intent.support,
    first_ts: intent.last_ts ?? now,
    tools: { ...intent.tools },
    skills: { ...intent.skills },
    usage,
    sources: {},
    queryIntentId: null,
    dirty: true,
  };
  if (intent.last_ts !== undefined) cluster.last_ts = intent.last_ts;
  if (intent.surfaced_tools) cluster.surfaced_tools = { ...intent.surfaced_tools };
  if (intent.surfaced_skills) cluster.surfaced_skills = { ...intent.surfaced_skills };
  return cluster;
}

function sliceFromWire(intent: IntentGraphIntent): SourceSlice {
  const slice: SourceSlice = {
    graphId: intent.id,
    support: intent.support,
    members: [...intent.members],
    tools: { ...intent.tools },
    skills: { ...intent.skills },
  };
  if (intent.last_ts !== undefined) slice.last_ts = intent.last_ts;
  if (intent.surfaced_tools) slice.surfaced_tools = { ...intent.surfaced_tools };
  if (intent.surfaced_skills) slice.surfaced_skills = { ...intent.surfaced_skills };
  return slice;
}

/** The cluster that best restates any of `phrases`, among those `eligible` allows. */
function bestMatch(
  index: ReturnType<typeof indexClusters>,
  phrases: readonly string[],
  byUuid: ReadonlyMap<string, EngineCluster>,
  eligible: (c: EngineCluster) => boolean,
): EngineCluster | null {
  let best: { cluster: EngineCluster; wording: number } | null = null;
  for (const phrase of phrases) {
    for (const c of index.candidates(phrase, new Set())) {
      if (c.wording < DEFAULT_THRESHOLDS.strong) break;
      const cluster = byUuid.get(c.key);
      if (!cluster || !eligible(cluster)) continue;
      if (!best || c.wording > best.wording) best = { cluster, wording: c.wording };
      break;
    }
  }
  return best?.cluster ?? null;
}
