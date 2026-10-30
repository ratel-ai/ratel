import { IntentGraph, ToolRegistry } from "@ratel-ai/sdk";
import type { IntentGraphDocument } from "@/lib/readings/intent-types/wire";

/**
 * Which ask group a search belongs to, decided by the open-source SDK's own
 * matcher, never by a reimplementation (ADR-0014; `fold.ts` holds the same
 * line). A graph's stored members are only its newest phrasings, so matching
 * a search's text against them would miss every search worded some other
 * way; the matcher reads a query the way the runtime does.
 *
 * The SDK answers "rank these tools for this query", not "which cluster", so
 * the question is put in its terms: a copy of the graph in which each group
 * answers with one stand-in tool of its own (`c:<id>`), over a catalog of only
 * those stand-ins with no text to match on. A query that matches a group gets
 * that group's stand-in first, marked fused; one that matches none gets
 * nothing. The real graph is never touched.
 *
 * A graph built on an embedding model needs that model to match a query, and
 * Cloud has none, so for it the group is the one whose stored phrasings hold
 * the query's exact text (folded for case and spacing).
 *
 * Privacy: queries and members are raw user text. Nothing here logs them.
 */

const STAND_IN = "c:";

export type ClusterOf = (query: string) => string | null;

/** Case-folded, whitespace-collapsed: how two phrasings are compared as text. */
export function foldQuery(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Attribution by stored phrasing: exact text, folded. */
export function clusterByMembers(document: IntentGraphDocument): ClusterOf {
  const byText = new Map<string, string>();
  for (const intent of document.intents) {
    for (const member of intent.members ?? []) {
      const key = foldQuery(member);
      if (!byText.has(key)) byText.set(key, intent.id);
    }
  }
  return (query) => byText.get(foldQuery(query)) ?? null;
}

export interface ClusterClassifier {
  clusterOf: ClusterOf;
  /** `matcher` is the SDK's; `phrasings` is exact stored text. */
  method: "matcher" | "phrasings";
  /** Why the SDK could not be used, for the caller to log; null when it was, or was never tried. */
  error: unknown;
}

/**
 * The SDK's attribution for this graph, or the phrasing match when the graph
 * needs an embedding model (or the SDK cannot read it, which the caller is
 * told). Build once per graph and call per search.
 */
export function createClusterClassifier(document: IntentGraphDocument): ClusterClassifier {
  if (document.model || document.intents.length === 0) {
    return { clusterOf: clusterByMembers(document), method: "phrasings", error: null };
  }
  let registry: ToolRegistry;
  try {
    const standIns: IntentGraphDocument = {
      ...document,
      intents: document.intents.map((intent) => ({
        ...intent,
        tools: { [`${STAND_IN}${intent.id}`]: 1 },
        skills: {},
        surfaced_tools: {},
        surfaced_skills: {},
      })),
    };
    const graph = IntentGraph.fromJson(JSON.stringify(standIns));
    registry = new ToolRegistry();
    for (const intent of document.intents) {
      // `register` is declared async but indexes in-process (see `registerAll` in match-quality/replay).
      void registry.register({
        id: `${STAND_IN}${intent.id}`,
        name: `group ${intent.id}`,
        description: "",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
      });
    }
    registry.experimentalEnableAdaptiveRanking(graph, { learn: false, warnOnModelMismatch: false });
  } catch (error) {
    // A document this SDK build cannot read still has its phrasings; the caller reports why.
    return { clusterOf: clusterByMembers(document), method: "phrasings", error };
  }
  return {
    clusterOf: (query) => {
      const top = registry.searchWithOrigin(query, 1, "agent")[0];
      return top?.fused && top.toolId.startsWith(STAND_IN)
        ? top.toolId.slice(STAND_IN.length)
        : null;
    },
    method: "matcher",
    error: null,
  };
}
