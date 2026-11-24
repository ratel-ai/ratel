import { cn } from "@ratel/design-system/cn";
import { DotMeter, type DotTone } from "@ratel/design-system/dot-matrix";
import { type Mood, moodOf, percent } from "@/components/console/sentiment/copy";

const MOOD: Record<Mood, { tone: DotTone; word: string }> = {
  satisfied: { tone: "success", word: "Satisfied" },
  mixed: { tone: "warning", word: "Mixed" },
  unsatisfied: { tone: "danger", word: "Unsatisfied" },
};

/**
 * A satisfaction score as its percent beside a row of pixels (DESIGN.md, "A
 * share next to its number"), the pixels colored by mood (satisfied from 70%,
 * mixed from 40%, unsatisfied below). The number keeps the text color, so the
 * score never rests on color alone. Large, the number leads.
 */
export function SatisfactionScore({
  score,
  size = "sm",
  className,
}: {
  score: number;
  size?: "sm" | "lg";
  className?: string;
}) {
  const mood = MOOD[moodOf(score)];
  const meter = (
    <DotMeter
      value={score}
      cells={size === "lg" ? 10 : 8}
      tone={mood.tone}
      label={`${mood.word}: ${percent(score)}`}
      className={size === "lg" ? "gap-[3px] [&>span]:size-2" : "max-sm:hidden"}
    />
  );
  return (
    <span
      className={cn("inline-flex items-center gap-3 tabular-nums", className)}
      title={`${mood.word}: ${percent(score)}`}
    >
      {size === "lg" ? null : meter}
      <span className={cn("text-fg", size === "sm" && "w-10 text-right")}>{percent(score)}</span>
      {size === "lg" ? meter : null}
    </span>
  );
}
