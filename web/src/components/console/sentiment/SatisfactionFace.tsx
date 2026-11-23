import { cn } from "@ratel/design-system/cn";
import { Frown, type LucideIcon, Meh, Smile } from "lucide-react";
import { type Mood, moodOf, percent } from "@/components/console/sentiment/copy";

const FACE: Record<Mood, { icon: LucideIcon; color: string; word: string }> = {
  satisfied: { icon: Smile, color: "text-success", word: "Satisfied" },
  mixed: { icon: Meh, color: "text-warning", word: "Mixed" },
  unsatisfied: { icon: Frown, color: "text-danger", word: "Unsatisfied" },
};

/**
 * A satisfaction score as a face and its percent, colored by mood (satisfied
 * from 70%, mixed from 40%, unsatisfied below). The percent always shows, so
 * the mood never rests on color or the face alone.
 */
export function SatisfactionFace({
  score,
  size = "sm",
  className,
}: {
  score: number;
  size?: "sm" | "lg";
  className?: string;
}) {
  const face = FACE[moodOf(score)];
  const Icon = face.icon;
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 tabular-nums", face.color, className)}
      title={`${face.word}: ${percent(score)}`}
    >
      <Icon
        aria-hidden
        className={size === "lg" ? "size-6" : "size-4"}
        strokeWidth={size === "lg" ? 2 : 2.25}
      />
      <span>{percent(score)}</span>
      <span className="sr-only">{face.word.toLowerCase()}</span>
    </span>
  );
}
