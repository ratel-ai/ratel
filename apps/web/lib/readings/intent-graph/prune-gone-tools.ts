import type { IntentGraphDocument, IntentGraphIntent } from "@/lib/readings/intent-types/wire";

/**
 * Drop tools the agent can no longer call from a Cloud graph as the fold
 * rewrites it (RC-725). Which tools are gone is ./catalog-drift.ts's rule, so
 * a project with no catalog never gets here with any.
 *
 * A gone tool's invoke and surfaced counts are removed from every ask group.
 * An ask group whose every edge was a gone tool lifts nothing anymore and is
 * dropped; one that had no edges to begin with is left as the learner made it.
 */

export interface PruneResult {
  graph: IntentGraphDocument;
  /** Invoke edges removed, across ask groups. */
  edgesPruned: number;
  /** Ask groups dropped because nothing they lifted was left. */
  intentsDropped: number;
}

function edgeCount(intent: IntentGraphIntent): number {
  return Object.keys(intent.tools).length + Object.keys(intent.skills).length;
}

function without(
  map: Record<string, number> | undefined,
  gone: ReadonlySet<string>,
): { map: Record<string, number> | undefined; removed: number } {
  if (!map) return { map, removed: 0 };
  let removed = 0;
  const kept: Record<string, number> = {};
  for (const [id, count] of Object.entries(map)) {
    if (gone.has(id)) removed += 1;
    else kept[id] = count;
  }
  return { map: removed > 0 ? kept : map, removed };
}

export function pruneGoneTools(graph: IntentGraphDocument, gone: ReadonlySet<string>): PruneResult {
  if (gone.size === 0) return { graph, edgesPruned: 0, intentsDropped: 0 };
  let edgesPruned = 0;
  let intentsDropped = 0;
  let changed = false;
  const intents: IntentGraphIntent[] = [];
  for (const intent of graph.intents) {
    const tools = without(intent.tools, gone);
    const surfaced = without(intent.surfaced_tools, gone);
    if (tools.removed === 0 && surfaced.removed === 0) {
      intents.push(intent);
      continue;
    }
    changed = true;
    edgesPruned += tools.removed;
    const next: IntentGraphIntent = { ...intent, tools: tools.map ?? {} };
    if (surfaced.map !== undefined) next.surfaced_tools = surfaced.map;
    if (tools.removed > 0 && edgeCount(next) === 0) {
      intentsDropped += 1;
      continue;
    }
    intents.push(next);
  }
  if (!changed) return { graph, edgesPruned: 0, intentsDropped: 0 };
  return { graph: { ...graph, intents }, edgesPruned, intentsDropped };
}

/** Every tool id a graph lifts or surfaced, for the gone rule to judge. */
export function graphToolIds(graph: IntentGraphDocument): Set<string> {
  const ids = new Set<string>();
  for (const intent of graph.intents) {
    for (const id of Object.keys(intent.tools)) ids.add(id);
    for (const id of Object.keys(intent.surfaced_tools ?? {})) ids.add(id);
  }
  return ids;
}
