/**
 * The shapes a fix carries from the tool crafter and the quality rewrites, declared here so the
 * fixes model can be read before either reading lands. Plain data; when the tool crafter and
 * quality arrive these become re-exports of their modules (the same names, the same fields).
 */

export const CRAFT_KINDS = [
  "merge_tools",
  "rewrite_tool",
  "fold_prerequisite",
  "deprecate_tool",
  "compose_chain",
  "parallel_pair",
  "tighten_schema",
  "enrich_response",
  "preload_context",
  "split_by_use",
  "fill_gap",
  "require_prerequisite",
] as const;
export type CraftKind = (typeof CRAFT_KINDS)[number];

/** One figure of a drafted change's worth, as a chip. */
export interface EffectChip {
  icon: "time" | "calls" | "failures" | "list" | "schema" | "model" | "cost" | "tokens";
  text: string;
  /** The derivation, for the tooltip. */
  title?: string;
}

/** A number behind a drafted change, as a label and a value. */
export interface EvidenceFact {
  label: string;
  value: string;
}

/**
 * What one model round trip costs the project, read off a signal run's day buckets: null
 * fields mean the project has no linked (or no priced) model calls.
 */
export interface RoundTripPrice {
  ms: number | null;
  usd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Linked model calls behind the figures. */
  modelCalls: number;
}

export const NO_PRICE: RoundTripPrice = {
  ms: null,
  usd: null,
  inputTokens: null,
  outputTokens: null,
  modelCalls: 0,
};

/** One span of a proposed description, marked where it differs from the current one. */
export interface DiffSpan {
  op: "same" | "added" | "removed";
  text: string;
}

export type ChangeDirection = "up" | "down" | "flat";

export interface SuggestionEffect {
  /** "+2 of 5" or the like. */
  delta: string;
  direction: ChangeDirection;
  /** "2 → 5 of 5 searches", or the catalog-wide pair for older replays. */
  detail: string;
}

export interface SuggestionExample {
  query: string | null;
  testHref: string | null;
}

/** A quality rewrite as its page shows it. */
export interface SuggestionRow {
  id: string;
  status: "pending" | "applied";
  toolId: string;
  toolName: string;
  /** Searches where this tool was the right answer and was not returned. */
  missed: number;
  change: "adds" | "rewrites";
  effect: SuggestionEffect | null;
  /** ISO time it was applied, for the Applied list. */
  appliedAt: string | null;
  spans: DiffSpan[];
  proposed: string;
  rationale: string;
  examples: SuggestionExample[];
  moreExamples: number;
}

const ACTION_FAILED = "Something went wrong. Nothing changed; try again in a moment.";

/**
 * A server action's answer, with a throw (a network drop, a server error) folded into a
 * failure, so the caller always gets one to show and the row it hid comes back.
 */
export async function settle(
  action: () => Promise<{ ok: boolean; message?: string }>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const result = await action();
    return result.ok ? { ok: true } : { ok: false, message: result.message ?? ACTION_FAILED };
  } catch {
    return { ok: false, message: ACTION_FAILED };
  }
}
