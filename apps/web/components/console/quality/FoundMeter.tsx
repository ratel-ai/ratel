import { cn } from "@ratel/design-system/cn";

/** The most pixels a meter draws; more searches than this scale down to it. */
const MAX_CELLS = 20;

/**
 * A rewrite's replay as square pixels (DESIGN.md, Brand: a share next to its
 * number): the searches its tool was found in before the rewrite, the ones the
 * rewrite adds in green, any it would lose in red, and the rest unlit. The
 * numbers always sit beside it in text; the label says them for a screen
 * reader.
 */
export function FoundMeter({
  n,
  before,
  after,
  label,
  className,
}: {
  /** The tool's replayed searches. */
  n: number;
  /** Found before the rewrite, and with it. */
  before: number;
  after: number;
  label: string;
  className?: string;
}) {
  if (n <= 0) return null;
  const cells = Math.min(n, MAX_CELLS);
  const scale = (value: number) => Math.round((Math.min(Math.max(value, 0), n) / n) * cells);
  const kept = scale(Math.min(before, after));
  const gained = scale(after) - kept;
  const lost = scale(before) - kept;
  return (
    <span
      role="img"
      aria-label={label}
      className={cn("inline-flex items-center gap-[2px]", className)}
    >
      {Array.from({ length: cells }, (_, index) => {
        const state =
          index < kept
            ? "kept"
            : index < kept + gained
              ? "gained"
              : index < kept + gained + lost
                ? "lost"
                : "missed";
        return (
          <span
            key={index}
            aria-hidden
            data-cell={state}
            className={cn(
              "size-1 shrink-0 rounded-[1px]",
              state === "kept" && "bg-fg-subtle",
              state === "gained" && "bg-success",
              state === "lost" && "bg-danger",
              state === "missed" && "bg-line-strong",
            )}
          />
        );
      })}
    </span>
  );
}
