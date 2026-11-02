/**
 * The shapes a fix carries from the tool crafter and the quality rewrites, under the names the
 * fixes model was written against before either reading landed. The crafter's are now
 * re-exports of its modules (`lib/synthesis/tool-crafter`, L5): the same names, the same
 * fields. The quality rewrite's row shapes stay here until its page model lands.
 */

export { NO_PRICE, type RoundTripPrice } from "@/lib/synthesis/tool-crafter/round-trip";
export type { EffectChip } from "@/lib/synthesis/tool-crafter/suggestion-model";
export { CRAFT_KINDS, type CraftKind } from "@/lib/synthesis/tool-crafter/types";
export type { EvidenceFact } from "@/lib/synthesis/tool-crafter/view";

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
