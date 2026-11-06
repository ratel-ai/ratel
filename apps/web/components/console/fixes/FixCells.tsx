import type { Tone } from "@ratel/design-system/badge";
import { cn } from "@ratel/design-system/cn";
import { Tooltip } from "@ratel/design-system/tooltip";
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { effectDirection } from "@/lib/views/fixes/effect";
import type {
  EffectReading,
  EvidenceStrength,
  Fix,
  FixEffect,
  FixEvidence,
  FixStats,
} from "@/lib/views/fixes/types";
import { EFFECT_ICON_LABELS, EFFECT_ICONS } from "./effect-icons";
import { FIX_KIND_ICONS } from "./kind-icons";

/**
 * The table's cells and the panel's small readings, shared so a fix reads
 * the same in both places. No state, no hooks.
 */

/** The kind's mark and the verb-first title, on one line; the why lives in the Panel. */
export function FixTitleCell({ fix }: { fix: Pick<Fix, "kind" | "short"> }) {
  const Icon = FIX_KIND_ICONS[fix.kind];
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Icon
        aria-hidden
        strokeWidth={1.5}
        data-fix-kind={fix.kind}
        className="size-4 shrink-0 text-fg-muted"
      />
      <span className="min-w-0 truncate font-medium text-fg">{fix.short}</span>
    </span>
  );
}

const TONE_CLASS = { good: "text-success", bad: "text-danger", neutral: "text-fg-subtle" } as const;

/** The arrow beside an effect: which way the number goes, colored by whether that is good for you. */
export function EffectArrow({
  effect,
  className,
}: {
  effect: Pick<FixEffect, "figure" | "tone">;
  className?: string;
}) {
  const direction =
    effectDirection(effect.figure) ??
    (effect.tone === "bad" ? "down" : effect.tone === "good" ? "up" : null);
  const Icon =
    direction === "down" ? ArrowDownRight : direction === "up" ? ArrowUpRight : ArrowRight;
  return (
    <>
      <Icon aria-hidden className={cn("size-3.5 shrink-0", TONE_CLASS[effect.tone], className)} />
      {effect.tone !== "neutral" ? (
        <span className="sr-only">{effect.tone === "good" ? "Better: " : "Worse: "}</span>
      ) : null}
    </>
  );
}

/**
 * The effect a row shows: the headline ("3 → 1 calls", the figure bright and
 * its unit quiet), then a mark for each other number it moves (a timer for
 * the waiting, a dollar for the cost), its figure in the tooltip, so a fix that
 * moves many numbers still fits. A fix with nothing measured says so.
 */
export function EffectValue({ effect }: { effect: FixEffect | null }) {
  if (!effect) return <span className="whitespace-nowrap text-fg-faint">Not measured</span>;
  return (
    <span className="flex min-w-0 max-w-full items-center gap-2.5 whitespace-nowrap">
      <span className="inline-flex min-w-0 items-center gap-1" data-effect={effect.tone}>
        <EffectArrow effect={effect} />
        {/* One line tall and wrapping: squeezed, the unit drops whole out of sight and the figure stays. */}
        <span className="flex h-5 min-w-0 flex-wrap items-center gap-x-1 overflow-hidden">
          <span className="text-fg tabular-nums">{effect.figure}</span>
          {effect.unit ? <span className="text-fg-subtle">{effect.unit}</span> : null}
        </span>
      </span>
      {effect.also.length > 0 ? (
        <span className="inline-flex shrink-0 items-center gap-1.5">
          {effect.also.map((reading) => (
            <EffectReadingMark key={reading.icon} reading={reading} />
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** One more number as its mark alone; the tooltip, and a screen reader, say it whole. */
function EffectReadingMark({ reading }: { reading: EffectReading }) {
  const Icon = EFFECT_ICONS[reading.icon];
  return (
    <Tooltip content={reading.label}>
      <span
        className="inline-flex text-fg-subtle hover:text-fg-muted"
        data-effect-reading={reading.icon}
      >
        <Icon aria-hidden strokeWidth={1.5} className="size-3.5" />
        <span className="sr-only">
          {EFFECT_ICON_LABELS[reading.icon]}: {reading.label}
        </span>
      </span>
    </Tooltip>
  );
}

/** Evidence as status (DESIGN.md, Color): strong is green, solid blue, early gray, always with its word. */
export const EVIDENCE_TONE: Readonly<Record<EvidenceStrength, Exclude<Tone, "accent">>> = {
  strong: "success",
  solid: "info",
  early: "neutral",
};

const EVIDENCE_DOT: Readonly<Record<EvidenceStrength, string>> = {
  strong: "bg-success",
  solid: "bg-info",
  early: "bg-fg-faint",
};

const EVIDENCE_TEXT: Readonly<Record<EvidenceStrength, string>> = {
  strong: "text-success",
  solid: "text-info",
  early: "text-fg-subtle",
};

/** Evidence in a dot and its word, both in the strength's color. */
export function EvidenceValue({
  evidence,
  className,
}: {
  evidence: Pick<FixEvidence, "strength" | "label"> | null;
  className?: string;
}) {
  if (!evidence) return <span className="text-fg-faint">–</span>;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap",
        EVIDENCE_TEXT[evidence.strength],
        className,
      )}
      data-evidence={evidence.strength}
    >
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", EVIDENCE_DOT[evidence.strength])}
      />
      {evidence.label}
    </span>
  );
}

const METER_CELLS = 24;
const STRENGTHS: readonly EvidenceStrength[] = ["strong", "solid", "early"];
const STRENGTH_WORD: Readonly<Record<EvidenceStrength, string>> = {
  strong: "strong",
  solid: "solid",
  early: "early",
};

/**
 * Every open fix's evidence as one row of pixels, strongest first: the share
 * of the list each strength holds, in its color (DESIGN.md, Brand: a share
 * as square pixels, its numbers beside it in text).
 */
export function EvidenceMeter({
  counts,
  className,
}: {
  counts: FixStats["evidence"];
  className?: string;
}) {
  const total = counts.strong + counts.solid + counts.early + counts.none;
  const cells = cellsOf(counts, total);
  const label = STRENGTHS.filter((strength) => counts[strength] > 0)
    .map((strength) => `${counts[strength]} ${STRENGTH_WORD[strength]}`)
    .join(", ");
  return (
    <span
      role="img"
      aria-label={`Evidence: ${label || "none yet"}`}
      className={cn("inline-flex flex-wrap items-center gap-[2px]", className)}
    >
      {cells.map((strength, index) => (
        <span
          key={index}
          aria-hidden
          className={cn(
            "size-1.5 rounded-[1px]",
            strength ? EVIDENCE_DOT[strength] : "bg-line-strong",
          )}
        />
      ))}
    </span>
  );
}

/** One cell per fix when they fit, else each strength's share of the cells (largest remainder), strongest first. */
function cellsOf(counts: FixStats["evidence"], total: number): (EvidenceStrength | null)[] {
  if (total === 0) return Array.from({ length: METER_CELLS }, () => null);
  const size = Math.min(total, METER_CELLS);
  const keys = [...STRENGTHS, "none"] as const;
  const exact = keys.map((key) => (counts[key] / total) * size);
  const floors = exact.map(Math.floor);
  let left = size - floors.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, remainder: value - floors[index]! }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    floors[index] = (floors[index] ?? 0) + 1;
    left -= 1;
  }
  return keys.flatMap((key, index) =>
    Array.from({ length: floors[index]! }, () => (key === "none" ? null : key)),
  );
}

/** The meter's words: each strength present, as a dot and its count. */
export function EvidenceLegend({
  counts,
  skip,
}: {
  counts: FixStats["evidence"];
  skip?: EvidenceStrength;
}) {
  const shown = STRENGTHS.filter((strength) => strength !== skip && counts[strength] > 0);
  if (shown.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      {shown.map((strength) => (
        <span key={strength} className="inline-flex items-center gap-1.5 tabular-nums">
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", EVIDENCE_DOT[strength])}
          />
          {counts[strength]} {STRENGTH_WORD[strength]}
        </span>
      ))}
    </span>
  );
}
