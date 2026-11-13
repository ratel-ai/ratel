import { Badge, type Tone } from "@ratel/design-system/badge";
import { cn } from "@ratel/design-system/cn";
import { ArrowDown, CircleCheck, CircleX, type LucideIcon } from "lucide-react";
import { type Outcome, outcomeOf, rankLabel } from "@/lib/views/quality/misses";

/**
 * Where the right tool landed, as a status (DESIGN.md, Color is meaning): green
 * when it came first, amber when it was ranked lower, red when the search did
 * not return it. Always an icon and a word, never color alone.
 */

const OUTCOME: Record<
  Outcome,
  { tone: Exclude<Tone, "neutral" | "info" | "accent">; icon: LucideIcon }
> = {
  first: { tone: "success", icon: CircleCheck },
  lower: { tone: "warning", icon: ArrowDown },
  missing: { tone: "danger", icon: CircleX },
};

export const OUTCOME_TEXT: Record<Outcome, string> = {
  first: "text-success",
  lower: "text-warning",
  missing: "text-danger",
};

export function OutcomeBadge({ rank, className }: { rank: number | null; className?: string }) {
  const outcome = outcomeOf(rank);
  const { tone, icon: Icon } = OUTCOME[outcome];
  return (
    <Badge tone={tone} className={className}>
      <Icon aria-hidden strokeWidth={1.75} />
      <span data-outcome={outcome}>{outcome === "first" ? "First" : rankLabel(rank)}</span>
    </Badge>
  );
}

/** The outcome's icon alone, for a ranked list's marked row; the row's badge says the word. */
export function OutcomeIcon({ rank, className }: { rank: number | null; className?: string }) {
  const outcome = outcomeOf(rank);
  const Icon = OUTCOME[outcome].icon;
  return (
    <Icon
      aria-hidden
      strokeWidth={1.75}
      className={cn("size-3.5 shrink-0", OUTCOME_TEXT[outcome], className)}
    />
  );
}
