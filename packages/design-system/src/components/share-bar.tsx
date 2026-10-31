import type { ReactNode } from "react";
import { cn } from "../cn";

export type ShareSegment = {
  id: string;
  label: ReactNode;
  /** Plain text for the accessible summary when `label` is not a string. */
  text?: string;
  value: number;
};

/** The categorical slots in their fixed order (DESIGN.md, Data visualization). */
const SLOTS = [
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-3",
  "bg-chart-4",
  "bg-chart-5",
  "bg-chart-6",
] as const;
const OTHER = "bg-fg-faint";

/** Six named slices at most; a seventh folds into "Other", never a recycled color. */
export function foldShares(segments: readonly ShareSegment[], max = SLOTS.length): ShareSegment[] {
  const positive = segments.filter((segment) => segment.value > 0);
  if (positive.length <= max) return positive;
  const kept = positive.slice(0, max - 1);
  const rest = positive.slice(max - 1);
  return [
    ...kept,
    {
      id: "other",
      label: `${rest.length} others`,
      text: `${rest.length} others`,
      value: rest.reduce((sum, segment) => sum + segment.value, 0),
    },
  ];
}

function percent(value: number, total: number): string {
  return `${Math.round((value / total) * 100)}%`;
}

/**
 * Shares of a whole as one stacked bar (never a pie), with a legend that
 * names each slice and its share. Color follows position in the list, so pass
 * segments in a stable order (busiest first).
 */
export function ShareBar({
  segments,
  label,
  legend = true,
  className,
}: {
  segments: readonly ShareSegment[];
  /** What the whole is: "Calls by tool". */
  label: string;
  legend?: boolean;
  className?: string;
}) {
  const shown = foldShares(segments);
  const total = shown.reduce((sum, segment) => sum + segment.value, 0);
  if (total <= 0) return null;
  const color = (index: number, id: string) =>
    id === "other" ? OTHER : SLOTS[index % SLOTS.length];
  const summary = shown
    .map(
      (segment) =>
        `${segment.text ?? (typeof segment.label === "string" ? segment.label : segment.id)} ${percent(segment.value, total)}`,
    )
    .join(", ");
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div role="img" aria-label={`${label}: ${summary}`} className="flex h-2 w-full gap-[2px]">
        {shown.map((segment, index) => (
          <span
            key={segment.id}
            aria-hidden
            className={cn(
              "h-full min-w-[3px] first:rounded-l-[4px] last:rounded-r-[4px]",
              color(index, segment.id),
            )}
            style={{ flexGrow: segment.value, flexBasis: 0 }}
          />
        ))}
      </div>
      {legend ? (
        <ul className="flex flex-col gap-1.5">
          {shown.map((segment, index) => (
            <li key={segment.id} className="flex items-center gap-2 text-ui">
              <span
                aria-hidden
                className={cn("size-2 shrink-0 rounded-[2px]", color(index, segment.id))}
              />
              <span className="min-w-0 flex-1 truncate text-fg">{segment.label}</span>
              <span className="text-fg-muted tabular-nums">{percent(segment.value, total)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
