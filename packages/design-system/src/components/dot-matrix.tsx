// biome-ignore-all lint/suspicious/noArrayIndexKey: fixed grids of dots, keyed by position, never reordered.
import { cn } from "../cn";

/**
 * The brand signature (DESIGN.md, Brand): pixel and dot-matrix marks, used
 * where they carry meaning (loading, empty, small meters and trends, canvases)
 * and never as decoration behind text. Dots rest in the line and faint grays;
 * coral marks only what is live or active.
 */

export const TONE = {
  neutral: "text-fg-subtle",
  accent: "text-accent-mark",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
} as const;

export type DotTone = keyof typeof TONE;

/**
 * The 5×5 mark at rest, for empty states: the loader's own diagonal, still.
 * Plain markup (no animation runtime), so it renders anywhere, tests included.
 */
export function DotEmblem({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("inline-grid grid-cols-5 gap-[3px] text-fg-faint", className)}>
      {Array.from({ length: 25 }, (_, index) => {
        const diagonal = (Math.floor(index / 5) + (index % 5)) / 8;
        return (
          <span
            key={index}
            className="size-1 rounded-full bg-current"
            style={{ opacity: 0.25 + diagonal * 0.75 }}
          />
        );
      })}
    </span>
  );
}

/** The 5×5 mark in motion, for a wait: a band of light crossing its diagonals. */
export function DotLoader({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("inline-grid grid-cols-5 gap-[1.5px] text-fg", className)}>
      {Array.from({ length: 25 }, (_, index) => {
        const diagonal = Math.floor(index / 5) + (index % 5);
        return (
          <span
            key={index}
            className="dot-loader-dot size-1 rounded-full bg-current"
            style={{ animationDelay: `${diagonal * 90}ms` }}
          />
        );
      })}
    </span>
  );
}

/**
 * A share as a row of square pixels (coverage, first try, capacity). The number
 * always sits next to it in text; the dots are the shape, not the value.
 */
export function DotMeter({
  value,
  cells = 20,
  tone = "accent",
  label,
  className,
}: {
  /** 0 to 1. */
  value: number;
  cells?: number;
  tone?: DotTone;
  label: string;
  className?: string;
}) {
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const lit = Math.round(clamped * cells);
  return (
    // biome-ignore lint/a11y/useSemanticElements: <meter> cannot hold the dots; the span carries its role.
    <span
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      className={cn("inline-flex items-center gap-[2px]", className)}
    >
      {Array.from({ length: cells }, (_, index) => (
        <span
          key={index}
          aria-hidden
          className={cn(
            "size-1 rounded-[1px]",
            index < lit ? cn("bg-current", TONE[tone]) : "bg-line-strong",
          )}
        />
      ))}
    </span>
  );
}

/**
 * A trend as columns of pixels, one per bucket, lit from the bottom. Tiny and
 * on-brand under a stat; use a real chart when the values themselves matter.
 *
 * A `null` bucket had no reading (too little data): it renders as an empty
 * column, so a gap never passes for a real zero, which keeps its unlit pixels.
 */
export function DotSpark({
  values,
  rows = 6,
  tone = "neutral",
  highlightLast = true,
  label,
  className,
}: {
  values: readonly (number | null)[];
  rows?: number;
  tone?: DotTone;
  /** The latest bucket in coral: what is happening now. */
  highlightLast?: boolean;
  label: string;
  className?: string;
}) {
  const readings = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  const max = Math.max(0, ...readings);
  return (
    <span
      role="img"
      aria-label={label}
      className={cn("inline-flex items-end gap-[2px]", className)}
    >
      {values.map((value, column) => {
        if (value === null || !Number.isFinite(value)) {
          return <span key={column} aria-hidden data-gap="" className="w-[3px] shrink-0" />;
        }
        const height = max > 0 && value > 0 ? Math.max(1, Math.round((value / max) * rows)) : 0;
        const last = highlightLast && column === values.length - 1;
        return (
          <span key={column} aria-hidden className="flex flex-col-reverse gap-[2px]">
            {Array.from({ length: rows }, (_, row) => (
              <span
                key={row}
                className={cn(
                  "size-[3px] rounded-[1px]",
                  row < height
                    ? last
                      ? "bg-accent-mark"
                      : cn("bg-current", TONE[tone])
                    : "bg-line",
                )}
              />
            ))}
          </span>
        );
      })}
    </span>
  );
}
