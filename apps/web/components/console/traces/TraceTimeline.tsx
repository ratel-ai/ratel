"use client";

import { cn } from "@ratel/design-system/cn";
import { ChevronRight } from "lucide-react";
import { type KeyboardEvent, memo, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { formatDuration } from "@/lib/synthesis/traces/v2/format";
import { STEP_KIND_LABEL, stepKind, stepTitle } from "@/lib/synthesis/traces/v2/span-kind";
import {
  hasChildren,
  type TimelineShape,
  timelineKeyMove,
  timeTicks,
  visibleRows,
} from "@/lib/synthesis/traces/v2/timeline";
import type { TraceWaterfallRow } from "@/lib/synthesis/traces/waterfall";
import { KIND_DOT } from "./kind";

/** Tree | time axis | duration. Header and rows share it, so the axis lines up. */
const GRID = "grid grid-cols-[minmax(13rem,38%)_minmax(0,1fr)_4.5rem] items-center";
/** Indentation per level, capped so a deep chain still leaves room for its names. */
const INDENT_PX = 14;
const MAX_INDENT_LEVELS = 16;

/**
 * The span tree on a shared time axis (DESIGN.md, Data visualization): plain
 * step names on the left, thin bars on a quiet grid, durations on the right.
 * A parent folds its children away; up and down move the selection, left and
 * right fold and step in and out, like a file tree. Rows skip layout while off
 * screen (`content-visibility`), so a 5,000-span run stays quick.
 */
export function TraceTimeline({
  rows,
  durationMs,
  shape,
  collapsed,
  selected,
  onSelect,
  onToggle,
}: {
  rows: readonly TraceWaterfallRow[];
  durationMs: number;
  shape: TimelineShape;
  collapsed: ReadonlySet<number>;
  selected: number;
  onSelect: (index: number) => void;
  onToggle: (index: number) => void;
}) {
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const ticks = useMemo(() => timeTicks(durationMs), [durationMs]);
  const visible = useMemo(() => visibleRows(shape, collapsed), [shape, collapsed]);
  // The key handler reads the tree through this ref, so it never changes and
  // a fold re-renders only the rows it touched, not all 5,000.
  const tree = useRef({ shape, collapsed, onSelect, onToggle });
  useLayoutEffect(() => {
    tree.current = { shape, collapsed, onSelect, onToggle };
  });

  const focusRow = useCallback((index: number) => {
    // Moves only land on visible rows, which are already mounted: focus now,
    // so a quick second key press reaches the row it is meant for.
    const row = rowRefs.current.get(index);
    if (row) row.focus();
    else requestAnimationFrame(() => rowRefs.current.get(index)?.focus());
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, index: number) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const current = tree.current;
      if ((event.key === "Enter" || event.key === " ") && hasChildren(current.shape, index)) {
        event.preventDefault();
        current.onToggle(index);
        return;
      }
      const move = timelineKeyMove(event.key, index, current.shape, current.collapsed);
      if (!move) return;
      event.preventDefault();
      if ("toggle" in move) {
        current.onToggle(move.toggle);
      } else {
        // Focus first: the next key press must start from the row it lands on,
        // whatever selecting it then does.
        focusRow(move.select);
        current.onSelect(move.select);
      }
    },
    [focusRow],
  );

  const setRef = useCallback((index: number, element: HTMLDivElement | null) => {
    if (element) rowRefs.current.set(index, element);
    else rowRefs.current.delete(index);
  }, []);

  return (
    // Its own scroll region: the axis stays in view however long the run is,
    // and the inspector beside it stays put.
    <div
      className="max-h-[calc(100dvh-16rem)] min-w-0 overflow-auto overscroll-contain rounded-lg border border-line"
      data-timeline
    >
      <div className="min-w-[44rem]">
        <div
          className={cn(
            GRID,
            "sticky top-0 z-sticky h-8 border-b border-line bg-app px-3 text-xs text-fg-subtle",
          )}
        >
          <span>Step</span>
          <span className="relative h-full" aria-hidden>
            {ticks.map((tick, position) => (
              <span
                key={tick.ms}
                className={cn(
                  "absolute top-1/2 -translate-y-1/2 whitespace-nowrap tabular-nums",
                  position === 0
                    ? "translate-x-0"
                    : tick.ratio >= 0.97
                      ? "-translate-x-full"
                      : "-translate-x-1/2",
                )}
                style={{ left: `${tick.ratio * 100}%` }}
              >
                {tick.label}
              </span>
            ))}
          </span>
          <span className="text-right">Duration</span>
        </div>

        <div className="relative">
          {/* The axis grid, once for the whole body rather than once per row. */}
          <div aria-hidden className={cn(GRID, "pointer-events-none absolute inset-0 px-3")}>
            <span />
            <span className="relative h-full">
              {ticks.map((tick) => (
                <span
                  key={tick.ms}
                  className="absolute inset-y-0 w-px bg-line"
                  style={{ left: `${tick.ratio * 100}%` }}
                />
              ))}
            </span>
            <span />
          </div>
          <div role="tree" aria-label="Steps in this trace" className="relative">
            {visible.map((index) => (
              <TimelineRow
                key={rows[index].span.spanId}
                row={rows[index]}
                index={index}
                selected={index === selected}
                expandable={hasChildren(shape, index)}
                expanded={!collapsed.has(index)}
                setRef={setRef}
                onSelect={onSelect}
                onToggle={onToggle}
                onKeyDown={onKeyDown}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const TimelineRow = memo(function TimelineRow({
  row,
  index,
  selected,
  expandable,
  expanded,
  setRef,
  onSelect,
  onToggle,
  onKeyDown,
}: {
  row: TraceWaterfallRow;
  index: number;
  selected: boolean;
  expandable: boolean;
  expanded: boolean;
  setRef: (index: number, element: HTMLDivElement | null) => void;
  onSelect: (index: number) => void;
  onToggle: (index: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, index: number) => void;
}) {
  const { span } = row;
  const kind = stepKind(span);
  const failed = span.statusCode === 2;
  const title = stepTitle(span);
  const left = Math.min(100, Math.max(0, row.offsetRatio * 100));
  const width = Math.min(100 - left, Math.max(0, row.durationRatio * 100));
  return (
    <div
      ref={(element) => setRef(index, element)}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={selected}
      aria-expanded={expandable ? expanded : undefined}
      aria-label={`${STEP_KIND_LABEL[kind]} ${title}, ${formatDuration(span.durationMs)}${failed ? ", failed" : ""}`}
      tabIndex={selected ? 0 : -1}
      data-span-id={span.spanId}
      data-step-kind={kind}
      data-failed={failed || undefined}
      onClick={() => onSelect(index)}
      onKeyDown={(event) => onKeyDown(event, index)}
      className={cn(
        GRID,
        "h-8 cursor-default px-3 text-ui outline-none [contain-intrinsic-size:auto_32px] [content-visibility:auto]",
        "hover:bg-hover focus-visible:shadow-[inset_2px_0_0_var(--ds-focus)]",
        selected && "bg-selected hover:bg-selected",
      )}
    >
      <span
        className="flex min-w-0 items-center gap-1.5 pr-3"
        style={{ paddingLeft: Math.min(row.depth, MAX_INDENT_LEVELS) * INDENT_PX }}
      >
        {expandable ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={expanded ? `Fold ${title}` : `Unfold ${title}`}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(index);
            }}
            className="-ml-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-hover hover:text-fg"
          >
            <ChevronRight
              aria-hidden
              className={cn(
                "size-3.5 transition-transform duration-120 motion-reduce:transition-none",
                expanded && "rotate-90",
              )}
            />
          </button>
        ) : (
          <span aria-hidden className="size-5 shrink-0" />
        )}
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", failed ? "bg-danger" : KIND_DOT[kind])}
        />
        <span className="shrink-0 text-fg-subtle">{STEP_KIND_LABEL[kind]}</span>
        <span
          className={cn("min-w-0 truncate", selected ? "text-fg" : "text-fg-muted")}
          title={span.name}
        >
          {title}
        </span>
        {row.orphaned ? (
          <span className="shrink-0 text-xs text-fg-subtle">(parent missing)</span>
        ) : null}
      </span>
      <span className="relative h-full">
        <span
          aria-hidden
          className={cn(
            "absolute top-1/2 h-1.5 -translate-y-1/2 rounded-[2px]",
            failed ? "bg-danger" : KIND_DOT[kind],
            !selected && "opacity-80",
          )}
          style={{ left: `${left}%`, width: `max(2px, ${width}%)` }}
        />
      </span>
      <span className={cn("text-right text-xs tabular-nums", failed ? "text-fg" : "text-fg-muted")}>
        {formatDuration(span.durationMs)}
      </span>
    </div>
  );
});
