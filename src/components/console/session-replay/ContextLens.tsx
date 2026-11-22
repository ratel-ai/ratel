import { cn } from "@ratel/design-system/cn";
import { Layers, PackageX, Unplug } from "lucide-react";
import type { LensPart } from "@/lib/views/session-replay/composition";
import type { MarkerKind, ViewRow } from "@/lib/views/session-replay/view";

/**
 * What one model call's input held, as one stacked bar (DESIGN.md: shares of a
 * whole are a single stacked bar). Each part keeps its color across calls, so
 * a color always names the same part. Six parts take the categorical slots;
 * user input and memory take the neutral grays.
 */

const PART_COLOR: Record<LensPart, string> = {
  system: "bg-chart-1",
  skills: "bg-chart-2",
  tools_used: "bg-chart-3",
  tools_unused: "bg-chart-4",
  history: "bg-chart-5",
  tool_results: "bg-chart-6",
  user_input: "bg-fg-muted",
  memory: "bg-fg-faint",
};

const MARKER_ICON: Record<MarkerKind, typeof Layers> = {
  unused_tool: PackageX,
  missing_tool: Unplug,
  bloat_start: Layers,
};

const n = (value: number) => value.toLocaleString("en-US");
const pct = (share: number) => `${Math.round(share * 100)}%`;

export function ContextBar({
  bar,
  className,
}: {
  bar: NonNullable<ViewRow["bar"]>;
  className?: string;
}) {
  const summary = bar.segments
    .map((segment) => `${segment.label} ${pct(segment.share)}`)
    .join(", ");
  return (
    <div
      role="img"
      aria-label={`Context of ${n(bar.total)} input tokens: ${summary}`}
      className={cn("flex h-2 w-full gap-[2px]", className)}
    >
      {bar.segments.map((segment) => (
        <span
          key={segment.part}
          aria-hidden
          title={`${segment.label}: ${n(segment.tokens)} tokens`}
          className={cn(
            "h-full min-w-[3px] first:rounded-l-[4px] last:rounded-r-[4px]",
            PART_COLOR[segment.part],
          )}
          style={{ flexGrow: segment.tokens, flexBasis: 0 }}
        />
      ))}
    </div>
  );
}

export function Markers({ markers }: { markers: ViewRow["markers"] }) {
  if (markers.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {markers.map((marker) => {
        const Icon = MARKER_ICON[marker.kind];
        return (
          <li
            key={marker.kind}
            data-lens-marker={marker.kind}
            className="flex items-start gap-2 text-ui text-fg-muted"
          >
            <Icon aria-hidden strokeWidth={1.5} className="mt-px size-3.5 shrink-0 text-warning" />
            <span>{marker.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The lens for one model call: the bar, every part with its tokens and share, and the call's markers. */
export function ContextLens({ row, gaps }: { row: ViewRow | null; gaps: readonly string[] }) {
  if (!row?.bar) {
    return (
      <p className="text-ui text-fg-subtle">
        No model call before this step, or its token split was not kept.
      </p>
    );
  }
  const bar = row.bar;
  return (
    <div className="flex flex-col gap-4" data-context-lens={row.index}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-semibold text-fg">Context at step {row.index}</p>
        <p className="text-xs text-fg-subtle tabular-nums">{n(bar.total)} input tokens</p>
      </div>
      <ContextBar bar={bar} />
      <ul className="flex flex-col gap-1.5">
        {bar.segments.map((segment) => (
          <li key={segment.part} className="flex items-center gap-2 text-ui">
            <span
              aria-hidden
              className={cn("size-2 shrink-0 rounded-[2px]", PART_COLOR[segment.part])}
            />
            <span className="min-w-0 flex-1 truncate text-fg">{segment.label}</span>
            <span className="text-fg-muted tabular-nums">{n(segment.tokens)}</span>
            <span className="w-10 text-right text-fg-subtle tabular-nums">
              {pct(segment.share)}
            </span>
          </li>
        ))}
      </ul>
      <Markers markers={row.markers} />
      {gaps.length > 0 ? (
        <ul className="flex flex-col gap-0.5 border-t border-line pt-3 text-xs text-fg-subtle">
          {gaps.map((gap) => (
            <li key={gap}>{gap}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
