import { formatCompact } from "@/lib/synthesis/traces/v2/format";
import type { ReadBy } from "@/lib/views/traces/sentiment/page-model";
import type { TaskFilter } from "@/lib/views/traces/sentiment/page-paths";

/** The one sentence under the page title, shared by the page and its skeleton. */
export const SENTIMENT_DESCRIPTION =
  "How people took your agent's work: satisfaction overall, by task status, by intent and day by day.";

/** The one sentence under Root cause analysis's title. */
export const ROOT_CAUSE_DESCRIPTION =
  "Why tasks were not completed, what got in the way of the ones completed after friction, and what it cost.";

export const READ_BY_MEANING: Record<ReadBy, string> = {
  rule: "Read from the trace by rules. No model.",
  model: "Read from people's messages by a model.",
  mixed: "Part read from the trace by rules, part from people's messages by a model.",
};

/** A cost in dollars; a cost under a cent keeps four places, since a turn's model calls often cost less. */
export function money(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Tokens, abbreviated: "1,284 tokens", "48.2K tokens". */
export function tokensLabel(tokens: number): string {
  return `${formatCompact(tokens)} tokens`;
}

export function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/**
 * Each task status's color, the same wherever a status shows (Agent health's
 * Task completion, Root cause analysis, Satisfaction by task status): green
 * when completed, yellow after friction, red when not completed. They are
 * statuses, so they take the status colors; the label always shows with
 * them. `bg` is a class, `fill` an SVG paint.
 */
export const STATUS_COLOR: Record<TaskFilter, { bg: string; fill: string }> = {
  completed: { bg: "bg-success", fill: "var(--ds-success)" },
  completed_after_friction: { bg: "bg-warning", fill: "var(--ds-warning)" },
  not_completed: { bg: "bg-danger", fill: "var(--ds-danger)" },
};

/** A satisfaction score as a mood: satisfied from 70%, mixed from 40%, unsatisfied below. */
export type Mood = "satisfied" | "mixed" | "unsatisfied";

export function moodOf(score: number): Mood {
  return score >= 0.7 ? "satisfied" : score >= 0.4 ? "mixed" : "unsatisfied";
}

/** What stands where no cause was found: written as a state, not a cause, and shown grey. */
export const NO_CAUSE_LABEL = "No cause found";
