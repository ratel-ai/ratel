import type { CorpusEntry } from "@/lib/readings/decisions/judge";
import { registerAll } from "@/lib/synthesis/match-quality/replay";
import type { Ranker } from "./simulate";
import type { FixChange } from "./types";

/**
 * The ranker the simulator ranks asks with: the SDK's native BM25
 * (`ToolRegistry` through `registerAll`, as Quality's replay and the
 * Playground rank), over the catalog as it is and as the change leaves it.
 * Built once per simulation; in-process, no network.
 */

/** Pinned as in `lib/match-quality/replay.ts`. */
const SEARCH_ORIGIN = "agent";

export function changedCorpus(corpus: readonly CorpusEntry[], change: FixChange): CorpusEntry[] {
  const hidden = new Set(change.hide);
  const kept = corpus.filter((entry) => !hidden.has(entry.entryId));
  const added: CorpusEntry[] = change.add
    .filter((tool) => !kept.some((entry) => entry.entryId === tool.id))
    .map((tool) => ({
      entryId: tool.id,
      name: tool.name,
      searchable: tool.searchable,
      source: "crafted",
      matchesAgentDescription: false,
      tags: [],
    }));
  return [...kept, ...added];
}

/** Null when the catalog is empty: nothing to rank against. */
export function createRanker(corpus: readonly CorpusEntry[], change: FixChange): Ranker | null {
  if (corpus.length === 0) return null;
  const before = registerAll(corpus, new Map());
  const after = registerAll(changedCorpus(corpus, change), new Map(Object.entries(change.patches)));
  const search = (registry: typeof before, query: string, depth: number) =>
    registry.searchWithOrigin(query, Math.max(1, depth), SEARCH_ORIGIN).map((hit) => hit.toolId);
  return {
    before: (query, depth) => search(before, query, depth),
    after: (query, depth) => search(after, query, depth),
  };
}
