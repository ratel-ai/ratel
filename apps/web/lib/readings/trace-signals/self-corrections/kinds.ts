import type { InvokeOutcome } from "@/lib/ledger/types";
import type { SelfCorrectionKind } from "@/lib/readings/trace-signals/self-corrections/detect";
import type { PhraseCategory } from "@/lib/readings/trace-signals/self-corrections/phrases";

/**
 * Self-corrections in plain words: the eight kinds a reader sees (DESIGN.md,
 * Glossary), and the four patterns that decide which fix an issue names. One
 * place, so the page, the issue copy and the summary card never disagree.
 */

/** A stored row's kind: one of the behaviour kinds, or a phrase in a reply. */
export type StoredCorrectionKind = SelfCorrectionKind | "phrase";

export const PLAIN_KINDS = [
  "retried",
  "switched",
  "gave_up",
  "searched_again",
  "asked_again",
  "apologized",
  "conceded",
  "backtracked",
] as const;

export type PlainKind = (typeof PLAIN_KINDS)[number];

export const PLAIN_KIND_LABELS: Readonly<Record<PlainKind, string>> = {
  retried: "Retried after an error",
  switched: "Switched tools",
  gave_up: "Gave up",
  searched_again: "Searched again",
  asked_again: "Asked again",
  apologized: "Apologized",
  conceded: "Conceded",
  backtracked: "Backtracked",
};

/** One plain sentence per kind, for a tooltip or a legend. */
export const PLAIN_KIND_MEANINGS: Readonly<Record<PlainKind, string>> = {
  retried: "A tool call failed and the agent called the same tool again.",
  switched: "A tool call failed and the agent tried a different tool next.",
  gave_up: "The last tool call failed and the agent stopped there.",
  searched_again: "The agent searched again for the same thing.",
  asked_again: "The person asked the same thing again in their next message.",
  apologized: "The agent said sorry.",
  conceded: "The agent admitted a mistake or agreed it was wrong.",
  backtracked: "The agent took back what it said or announced a do-over.",
};

/** The phrase categories behind each plain phrase kind. */
const PHRASE_PLAIN: Readonly<Record<PhraseCategory, PlainKind>> = {
  apology: "apologized",
  admission: "conceded",
  concession: "conceded",
  backtrack: "backtracked",
  retry: "backtracked",
};

const BEHAVIOUR_PLAIN: Readonly<Record<SelfCorrectionKind, PlainKind>> = {
  retry_after_error: "retried",
  switch_after_error: "switched",
  gave_up_after_error: "gave_up",
  searched_again: "searched_again",
  asked_again: "asked_again",
};

/** The plain kind of a stored row; null for a phrase row without a known category. */
export function plainKindOf(kind: string, phraseCategory: string | null): PlainKind | null {
  if (kind === "phrase")
    return phraseCategory && phraseCategory in PHRASE_PLAIN
      ? PHRASE_PLAIN[phraseCategory as PhraseCategory]
      : null;
  return kind in BEHAVIOUR_PLAIN ? BEHAVIOUR_PLAIN[kind as SelfCorrectionKind] : null;
}

/** The phrase categories folded into one plain kind, for reading rows back by kind. */
export function phraseCategoriesOf(kind: PlainKind): PhraseCategory[] {
  return (Object.keys(PHRASE_PLAIN) as PhraseCategory[]).filter(
    (category) => PHRASE_PLAIN[category] === kind,
  );
}

/** The behaviour kind behind a plain kind, or null for the phrase kinds. */
export function behaviourKindOf(kind: PlainKind): SelfCorrectionKind | null {
  const entry = (Object.entries(BEHAVIOUR_PLAIN) as [SelfCorrectionKind, PlainKind][]).find(
    ([, plain]) => plain === kind,
  );
  return entry?.[0] ?? null;
}

export type PlainKindCounts = Record<PlainKind, number>;

export function zeroPlainCounts(): PlainKindCounts {
  return Object.fromEntries(PLAIN_KINDS.map((kind) => [kind, 0])) as PlainKindCounts;
}

/**
 * Which fix a self-correction calls for, from the tool call before it:
 *
 * - `failed`: the call before it failed. Retries, switches and give-ups are
 *   always this; so is an apology or a repeated ask right after a failure.
 * - `empty`: the call before it worked but came back with nothing (a
 *   captured empty result), and the agent apologized, backtracked or asked
 *   for it again.
 * - `backtrack`: the call before it worked and returned something, and the
 *   agent still took it back or searched or was asked again: it picked the
 *   wrong tool, so that tool's description misled it.
 * - `unanswered`: no tool was called before it: nothing the agent has could
 *   answer.
 */
export const FIX_PATTERNS = ["failed", "empty", "backtrack", "unanswered"] as const;

export type FixPattern = (typeof FIX_PATTERNS)[number];

export interface PatternInput {
  tool: string | null;
  toolOutcome: InvokeOutcome | string | null;
  /** The call before it returned a captured empty result. */
  toolEmpty: boolean;
}

export function patternOf(event: PatternInput): FixPattern {
  if (event.tool === null) return "unanswered";
  if (event.toolOutcome === "error") return "failed";
  return event.toolEmpty ? "empty" : "backtrack";
}

/**
 * The fix line for a pattern, naming the tool (or, for `unanswered`, what
 * people asked for). Plain words, a full stop, no engine names.
 */
export function fixLine(
  pattern: FixPattern,
  subject: { tool: string | null; topic: string | null },
): string {
  const tool = subject.tool ?? "this tool";
  switch (pattern) {
    case "failed":
      return `Make ${tool} fail with a clear message, or retry inside the tool.`;
    case "empty":
      return `Add a skill that says what to do when ${tool} returns nothing.`;
    case "backtrack":
      return `Rewrite ${tool}'s searchable description.`;
    case "unanswered":
      return `Build a tool or add a skill for ${subject.topic ?? "these requests"}.`;
  }
}

/** A short name for each pattern, for a fix's "why" line. */
export const PATTERN_REASONS: Readonly<Record<FixPattern, string>> = {
  failed: "Failures before it",
  empty: "Apologies after empty results",
  backtrack: "Backtracks after a tool",
  unanswered: "Nothing could answer",
};
