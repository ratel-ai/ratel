"use client";

import { cn } from "@ratel/design-system/cn";
import { ArrowDown, ArrowUp, BookOpen, Wrench } from "lucide-react";
import type { RowChange } from "@/lib/synthesis/playground/calibration-compare";
import type { CapabilityKind } from "@/lib/synthesis/playground/types";

/** One glyph per idea, used everywhere that idea appears. */

const KIND_ICON = { skill: BookOpen, tool: Wrench } as const;

export function KindIcon({ kind, className }: { kind: CapabilityKind; className?: string }) {
  const Icon = KIND_ICON[kind];
  return <Icon className={cn("shrink-0", className)} strokeWidth={1.75} aria-hidden />;
}

export const KIND_NOUN: Record<CapabilityKind, string> = {
  skill: "Skill",
  tool: "Tool",
};

const MOVE_ICON = { up: ArrowUp, down: ArrowDown } as const;

const CHANGE_TONE = {
  up: "text-green",
  down: "text-coral",
  new: "text-green",
} as const;

/** How far a row moved against the column to its left. */
export function ChangeMark({ change, delta }: { change: RowChange; delta: number | null }) {
  if (change === "same") return null;

  if (change === "new") {
    return (
      <span
        className={cn(
          "shrink-0 rounded-sm border border-green/30 px-1 font-mono text-[9px] uppercase tracking-[0.06em]",
          CHANGE_TONE.new,
        )}
        title="Not in the column to the left"
      >
        new
      </span>
    );
  }

  const Icon = MOVE_ICON[change];
  const places = delta === null ? null : Math.abs(delta);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 font-mono text-[10px] tabular-nums",
        CHANGE_TONE[change],
      )}
      title={`Moved ${places} place${places === 1 ? "" : "s"} ${change} from the column to the left`}
    >
      <Icon className="size-2.5" strokeWidth={2.5} aria-hidden />
      {places}
      <span className="sr-only">{`moved ${change} ${places ?? ""}`}</span>
    </span>
  );
}
