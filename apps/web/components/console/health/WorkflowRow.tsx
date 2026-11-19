"use client";

import { cn } from "@ratel/design-system/cn";
import { createElement, useLayoutEffect, useRef } from "react";
import { RowChevron } from "@/components/console/health/SignalCard";
import { WorkflowDetails } from "@/components/console/health/WorkflowDetails";
import { workflowIconComponent } from "@/components/console/health/workflow-icons";
import {
  type WorkflowStatus,
  workflowRowSummary,
} from "@/components/console/health/workflow-row-model";
import type { WorkflowRowView } from "@/lib/readings/trace-signals/view";

export interface WorkflowRowProps {
  projectId: string;
  row: WorkflowRowView;
  open: boolean;
  /** Only the row the reader clicked animates; a row closed by another opening folds at once. */
  animate: boolean;
  onToggle: () => void;
  /** Kept in the markup but not shown until "Show all". */
  hidden: boolean;
  /** Whether the map below shows only this workflow. */
  onMap: boolean;
  onShowOnMap?: () => void;
}

/** Needs attention in coral, an opportunity in blue, healthy in grey. */
const PILL: Readonly<Record<WorkflowStatus, string>> = {
  failing: "border-coral/40 bg-coral/10 text-coral",
  slow: "border-coral/40 bg-coral/10 text-coral",
  build: "border-ctx-memory/40 bg-ctx-memory/10 text-ctx-memory",
  fine: "border-forest-300 bg-forest-600/60 text-warm-muted",
};

/** The row's columns (icon, name, status, runs, finish, chevron), shared with the header line above the rows. */
export const WORKFLOW_ROW_GRID =
  "grid grid-cols-[1rem_minmax(0,1fr)_2.75rem_2.75rem_1.75rem] items-center gap-x-2.5 sm:grid-cols-[1rem_minmax(0,1fr)_5.5rem_4rem_3.5rem_1.75rem] sm:gap-x-3";

function StatusPill({
  status,
  label,
  className,
}: {
  status: WorkflowStatus;
  label: string;
  className?: string;
}) {
  return (
    <span
      data-workflow-status={status}
      className={cn(
        "inline-flex w-fit items-center whitespace-nowrap rounded-full border px-2 py-px text-[11px] font-medium leading-4",
        PILL[status],
        className,
      )}
    >
      {label}
    </span>
  );
}

/**
 * One workflow as a single line (icon, name, status pill, runs, finish rate) that
 * opens in place. The clicked row stays under the pointer while another row
 * above it folds away.
 */
export function WorkflowRow({
  projectId,
  row,
  open,
  animate,
  onToggle,
  hidden,
  onMap,
  onShowOnMap,
}: WorkflowRowProps) {
  const summary = workflowRowSummary(row);
  // createElement, not JSX: the component is looked up from the row's key, never created here.
  const icon = createElement(workflowIconComponent(row.icon), {
    "aria-hidden": true,
    className: "size-4 text-warm-muted",
  });
  const bodyId = `workflow-${row.id}-body`;
  const ref = useRef<HTMLLIElement>(null);
  const clickTop = useRef<number | null>(null);

  const toggle = () => {
    clickTop.current = ref.current?.getBoundingClientRect().top ?? null;
    onToggle();
  };

  useLayoutEffect(() => {
    const before = clickTop.current;
    clickTop.current = null;
    if (before === null || !ref.current) return;
    const moved = ref.current.getBoundingClientRect().top - before;
    if (Math.abs(moved) > 1) window.scrollBy(0, moved);
  }, [open]);

  return (
    <li
      ref={ref}
      hidden={hidden || undefined}
      data-workflow-row={row.id}
      data-workflow-open={open ? "true" : "false"}
    >
      <div
        className={cn(
          "group/row rounded-xl transition-colors duration-200",
          open || onMap
            ? "bg-forest-600/80 ring-1 ring-inset ring-forest-300/70"
            : "bg-forest-600/30 hover:bg-forest-600/60 has-[>button:focus-visible]:bg-forest-600/60",
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
          className={cn(
            WORKFLOW_ROW_GRID,
            "w-full cursor-pointer rounded-xl px-3 py-2.5 text-left focus-visible:outline-offset-[-2px] sm:px-4",
          )}
        >
          {icon}
          <span className="flex min-w-0 flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2">
            <span className="line-clamp-2 text-[14px] font-medium leading-5 text-cream">
              {row.name}
            </span>
            {onMap && (
              <span className="hidden shrink-0 rounded-full border border-forest-300 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.1em] text-warm-muted sm:inline">
                On the map
              </span>
            )}
            {/* On a phone the pill sits under the name, so the name keeps the width. */}
            <StatusPill status={summary.status} label={summary.statusLabel} className="sm:hidden" />
          </span>
          <span className="hidden sm:flex">
            <StatusPill status={summary.status} label={summary.statusLabel} />
          </span>
          <span className="text-right text-[13px] tabular-nums text-cream-dim">
            {summary.runs}
            <span className="sr-only">{row.runs === 1 ? " run" : " runs"}</span>
          </span>
          <span className="text-right font-display text-[15px] font-semibold tabular-nums text-cream">
            <span className="sr-only">finish </span>
            {summary.finish}
          </span>
          <RowChevron open={open} />
        </button>
        <div
          className={cn(
            "grid",
            animate &&
              "transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none",
            open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div id={bodyId} className="min-h-0 min-w-0 overflow-hidden" inert={!open || undefined}>
            <WorkflowDetails projectId={projectId} row={row} onShowOnMap={onShowOnMap} />
          </div>
        </div>
      </div>
    </li>
  );
}
