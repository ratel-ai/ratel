import type { CraftKind } from "@/lib/synthesis/tool-crafter/types";

/**
 * Every per-kind fact the crafter states, in one place: what the kind is
 * called (verb, label), what it means in one sentence, how the guide orders
 * it, which kinds are notes rather than definitions, and the rank that breaks
 * ties between suggestions. The rules that pick and draft each kind live in
 * `candidates.ts` and `draft.ts`; what the row says about its evidence lives
 * in `view.ts` and `suggestion-model.ts`.
 */

/** The short verb on the kind pill. */
export const KIND_VERBS: Record<CraftKind, string> = {
  merge_tools: "Merge",
  fold_prerequisite: "Fold in",
  rewrite_tool: "Rewrite",
  deprecate_tool: "Retire",
  compose_chain: "Compose",
  parallel_pair: "Parallel",
  tighten_schema: "Tighten",
  enrich_response: "Enrich",
  preload_context: "Pre-load",
  split_by_use: "Split by use",
  fill_gap: "New tool",
  require_prerequisite: "Prerequisite",
};

/** The longer label the MCP reads. */
export const KIND_LABELS: Record<CraftKind, string> = {
  merge_tools: "Merge two tools",
  rewrite_tool: "Rewrite retrieval text",
  fold_prerequisite: "Fold a lookup in",
  deprecate_tool: "Retire a tool",
  compose_chain: "Compose a chain",
  parallel_pair: "Mark a pair independent",
  tighten_schema: "Tighten a schema",
  enrich_response: "Enrich a response",
  preload_context: "Pre-load context",
  split_by_use: "One tool used two ways",
  fill_gap: "An ask with no tool",
  require_prerequisite: "Make a prerequisite explicit",
};

/** What each kind of suggestion is, said once in plain words: the open suggestion and the kind guide show it. */
export const KIND_PLAIN: Record<CraftKind, string> = {
  merge_tools:
    "These two tools are always used together, so make them one tool. The agent finds one thing and makes one call.",
  fold_prerequisite:
    "The first tool only ever exists to look something up for the second. Let the second accept that input directly, so the agent skips the lookup.",
  compose_chain:
    "For this ask, the agent calls these tools one after another, in the same order every time. Make one tool that does the whole sequence in one call. The agent calls it once instead of deciding step by step.",
  parallel_pair:
    "These two tools don't depend on each other, but the agent calls them one after another. Tell it to call both in one go.",
  tighten_schema:
    "The agent's first call to this tool often fails and the retry works: the arguments are unclear. Describe them, and list the allowed values.",
  require_prerequisite:
    "This tool fails when another tool didn't run first. Let it do that first step itself when the caller skipped it.",
  enrich_response:
    "After the first tool answers, the agent always calls the second one to fetch one more thing. Put that thing in the first tool's answer, and the second call isn't needed.",
  preload_context:
    "Every time this ask comes in, the agent's first move is the same lookup. Hand it that lookup's result together with the request, and the turn starts one call shorter.",
  split_by_use:
    "After this tool, the agent always does one thing under one ask and a different thing under another. The tool's output is used two ways: give each its own variant, or return both.",
  fill_gap:
    "For this ask the agent takes a different path every time, through many tools and many calls. No tool answers it directly; one that does would replace the detour.",
  deprecate_tool:
    "Nobody called this tool in the window. Remove it; every tool list the agent reads gets shorter.",
  rewrite_tool:
    "Users ask for this tool in words its description doesn't use, so retrieval misses it. Add those words.",
};

/** A merge found in one intent's own pattern, said in plain words: the two tools stay for everything else. */
export const INTENT_MERGE_PLAIN =
  "For this intent the agent calls these two tools one after the other, in the same order. Add one tool that does both in one call; keep the two for everything else.";

/**
 * The kinds the crafter drafts, in the order the guide lists them: the ones
 * that remove a call first, then the ones that make a call succeed, then the
 * ones that change what the catalog says.
 */
export const GUIDE_KINDS: readonly CraftKind[] = [
  "merge_tools",
  "fold_prerequisite",
  "compose_chain",
  "parallel_pair",
  "enrich_response",
  "preload_context",
  "tighten_schema",
  "require_prerequisite",
  "split_by_use",
  "fill_gap",
  "deprecate_tool",
  "rewrite_tool",
];

/** Kinds whose proposal is a note to the customer, not a definition: nothing crafted, nothing hidden. */

/** Kinds whose proposal is a note to the customer, not a definition: nothing crafted, nothing hidden. */
export const NOTES_ONLY_KINDS: ReadonlySet<CraftKind> = new Set<CraftKind>([
  "tighten_schema",
  "enrich_response",
  "preload_context",
  "split_by_use",
  "fill_gap",
]);

/** Rank of a kind when no measured saving separates two suggestions: what pays most first. */
export const KIND_RANK: Record<CraftKind, number> = {
  merge_tools: 0,
  fold_prerequisite: 0,
  compose_chain: 0,
  require_prerequisite: 1,
  tighten_schema: 1,
  parallel_pair: 1,
  enrich_response: 0,
  preload_context: 0,
  split_by_use: 1,
  fill_gap: 0,
  deprecate_tool: 2,
  rewrite_tool: 3,
};

export interface KindGuideRow {
  kind: CraftKind;
  verb: string;
  /** One or two plain sentences: what the pattern is and what the fix does. */
  plain: string;
}

export function kindGuide(): KindGuideRow[] {
  return GUIDE_KINDS.map((kind) => ({ kind, verb: KIND_VERBS[kind], plain: KIND_PLAIN[kind] }));
}
