import type { FixKind } from "@/lib/views/fixes/kinds";

/**
 * What a shipped fix changes in the agent's tool calls, from its kind and the
 * tools it names, in their order: the tools whose calls change (watch their
 * errors and latency) and the tools the agent stops calling (any call after
 * the ship is a regression). Pure, client-safe.
 */

export interface ToolChanges {
  changed: string[];
  removed: string[];
}

type Split = "first-stays" | "last-stays" | "all-change" | "all-go";

/**
 * - first-stays: the first tool does the work of the others (enrich: it returns
 *   what the second fetches; merge, combine: one tool for the pair or chain).
 * - last-stays: the main tool takes in its prerequisite (fold).
 * - all-go: the agent no longer calls them (retire; preload puts the result in context).
 * - all-change: the tools stay and behave or read differently.
 */
const SPLIT: Record<FixKind, Split> = {
  enrich: "first-stays",
  merge: "first-stays",
  combine: "first-stays",
  fold: "last-stays",
  retire: "all-go",
  preload: "all-go",
  rewrite: "all-change",
  schema: "all-change",
  "fail-clearly": "all-change",
  parallel: "all-change",
  split: "all-change",
  prerequisite: "all-change",
  "tell-apart": "all-change",
  build: "all-change",
  skill: "all-change",
  "fewer-results": "all-change",
};

export function toolChanges(kind: FixKind, toolIds: readonly string[]): ToolChanges {
  const tools = [...new Set(toolIds)];
  if (tools.length === 0) return { changed: [], removed: [] };
  switch (SPLIT[kind]) {
    case "first-stays":
      return { changed: tools.slice(0, 1), removed: tools.slice(1) };
    case "last-stays":
      return { changed: tools.slice(-1), removed: tools.slice(0, -1) };
    case "all-go":
      return { changed: [], removed: tools };
    case "all-change":
      return { changed: tools, removed: [] };
  }
}
