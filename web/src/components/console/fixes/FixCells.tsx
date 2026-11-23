"use client";

import type { Tone } from "@ratel/design-system/badge";
import { cn } from "@ratel/design-system/cn";
import { fixSavingsText } from "@/lib/views/fixes/period";
import type {
  EvidenceStrength,
  Fix,
  FixEffect,
  FixEvidence,
  FixGain,
  FixStats,
} from "@/lib/views/fixes/types";
import { FIX_KIND_ICONS } from "./kind-icons";
import { useSavingsPeriod } from "./url";

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

/** Show the measured savings as plain text in rows and Panels. */
export function EffectValue({
  effect,
  gain,
  className,
}: {
  effect: FixEffect | null;
  gain?: FixGain | null;
  className?: string;
}) {
  const [period] = useSavingsPeriod();
  const text = gain === undefined ? effect?.value : fixSavingsText(gain, period);
  return (
    <span
      className={cn("text-fg tabular-nums", !text && "text-fg-faint", className)}
      data-effect={effect?.tone}
    >
      {text ?? "Not measured"}
    </span>
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
