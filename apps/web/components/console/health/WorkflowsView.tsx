"use client";

import { cn } from "@ratel/design-system/cn";
import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import {
  SectionPreview,
  UnservedPreviewRows,
  WorkflowPreviewRows,
} from "@/components/console/health/SectionPreview";
import {
  readingSinceText,
  SEARCH_ASKS_TEXT,
} from "@/components/console/health/section-preview-model";
import { openSetupGuide } from "@/components/console/health/setup-guide-events";
import { useSharedSurface } from "@/components/console/health/surface";
import { UnservedAsks } from "@/components/console/health/UnservedAsks";
import { WORKFLOW_ROW_GRID, WorkflowRow } from "@/components/console/health/WorkflowRow";
import { workflowsEmptyReason, workflowsSummary } from "@/components/console/health/workflow-copy";
import { useWorkflowFocus } from "@/components/console/health/workflow-focus";
import type {
  WorkflowRowView,
  WorkflowsView as WorkflowsModel,
} from "@/lib/readings/trace-signals/view";
import { LIST_TOP_OFFSET_PX } from "@/lib/views/health/card-model";
import { tasksHref } from "@/lib/views/tasks/paths";

export interface WorkflowsViewProps {
  projectId: string;
  workflows: WorkflowsModel;
  /** False when the map has no journey to focus (runs stored before it): rows then offer no map button. */
  focusable: boolean;
  /** Which lane's setup guides the previews point at; SDK by default. */
  lane?: "sdk" | "otel";
  /** True when no request text arrives at all, so requests no workflow handles can never be read. */
  asksMissing?: boolean;
}

/** Rows shown before "Show all". */
export const WORKFLOW_ROWS_SHOWN = 5;

/**
 * The Tasks section: the groups of tools called together for one request,
 * most runs first, one line each (status dot, name, runs, finish rate). A
 * row opens in place, one at a time, with its steps, its top problem and the
 * ways forward: its task page, the map focused on it, or an example run in
 * Traces. The title opens Tasks. Requests no task or tool handles fold into
 * one line at the end.
 */
export function WorkflowsView({
  projectId,
  workflows,
  focusable,
  lane = "sdk",
  asksMissing = false,
}: WorkflowsViewProps) {
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [toggled, setToggled] = useState<string | null>(null);
  const shared = useWorkflowFocus();
  // The public copy links nowhere inside the project.
  const publicCopy = useSharedSurface();
  const { items } = workflows;
  const hidden = Math.max(0, items.length - WORKFLOW_ROWS_SHOWN);
  const canFocus = focusable && shared !== null;

  const toggle = (id: string) => {
    setToggled(id);
    setOpenId(openId === id ? null : id);
  };
  const showOnMap = (row: WorkflowRowView) => {
    shared?.setFocus(row);
    revealMap();
  };

  return (
    <section
      aria-labelledby={`${listId}-title`}
      data-workflows="true"
      className="card-enter rounded-2xl border border-forest-300 bg-forest-600/40 p-4 sm:p-5"
      style={{ animationDelay: "540ms" }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={`${listId}-title`} className="font-display text-lg font-semibold text-cream">
          {publicCopy ? (
            "Tasks"
          ) : (
            <Link
              href={tasksHref(projectId)}
              className="rounded outline-none hover:underline focus-visible:ring-2 focus-visible:ring-coral/60"
            >
              Tasks
            </Link>
          )}
        </h2>
        {items.length > 0 && (
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-warm-muted">
            {workflowsSummary(workflows)}
          </span>
        )}
      </div>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-warm-muted">
        Tools called together for one request. Open one for its steps and what to fix.
      </p>
      {workflows.readingSince && !workflows.blocked && (
        <p data-workflows-since="true" className="mt-1 text-[12px] leading-5 text-warm-muted">
          {readingSinceText(workflows.readingSince, workflows.excludedRuns)}
        </p>
      )}
      {workflows.blocked ? (
        <SectionPreview reason={workflows.blocked} lane={lane}>
          <WorkflowPreviewRows />
        </SectionPreview>
      ) : items.length === 0 ? (
        <p
          data-workflows-empty="true"
          className="mt-4 rounded-xl border border-dashed border-forest-300 bg-base-deep/30 px-4 py-3 text-[13px] leading-5 text-warm-muted"
        >
          {workflowsEmptyReason(workflows)}
        </p>
      ) : (
        <>
          <div
            aria-hidden
            className={cn(
              WORKFLOW_ROW_GRID,
              "mt-3 px-3 font-mono text-[10px] uppercase tracking-[0.1em] text-warm-muted sm:px-4",
            )}
          >
            <span />
            <span>Task</span>
            <span className="hidden sm:block">Status</span>
            <span className="text-right">Runs</span>
            <span className="text-right">Finish</span>
            <span />
          </div>
          <ul id={listId} className="mt-1.5 flex flex-col gap-1.5">
            {items.map((row, index) => (
              <WorkflowRow
                key={row.id}
                projectId={projectId}
                row={row}
                open={openId === row.id}
                animate={toggled === row.id}
                onToggle={() => toggle(row.id)}
                hidden={!expanded && index >= WORKFLOW_ROWS_SHOWN}
                onMap={shared?.focus?.id === row.id}
                onShowOnMap={canFocus ? () => showOnMap(row) : undefined}
              />
            ))}
          </ul>
          {hidden > 0 && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded(!expanded)}
              className="mt-1.5 flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] font-medium text-cream-dim transition-colors hover:bg-forest-600/50 hover:text-cream focus-visible:outline-offset-[-2px]"
            >
              {expanded
                ? `Show only the top ${WORKFLOW_ROWS_SHOWN}`
                : `Show all ${items.length} tasks`}
              <ChevronDown
                aria-hidden
                className={cn(
                  "size-4 transition-transform duration-300 motion-reduce:transition-none",
                  expanded && "rotate-180",
                )}
              />
            </button>
          )}
        </>
      )}
      {!workflows.blocked && workflows.unserved.length > 0 && (
        <UnservedAsks projectId={projectId} asks={workflows.unserved} />
      )}
      {!workflows.blocked && items.length > 0 && asksMissing && (
        <SectionPreview reason="no_asks" lane={lane} className="min-h-[9.5rem]">
          <UnservedPreviewRows />
        </SectionPreview>
      )}
      {!workflows.blocked && workflows.asksFrom === "search" && (
        <p data-workflows-asks="search" className="mt-3 text-[12px] leading-5 text-warm-muted">
          {SEARCH_ASKS_TEXT}{" "}
          <button
            type="button"
            onClick={() => openSetupGuide("sdk_user_messages")}
            className="font-medium text-cream-dim underline decoration-forest-300 underline-offset-2 hover:text-cream"
          >
            How
          </button>
        </p>
      )}
    </section>
  );
}

/** Brings the map's top into view when it is off screen, so a pick is seen where it lands. */
function revealMap(): void {
  const map = document.querySelector<HTMLElement>("[data-tool-flow-map]");
  if (!map) return;
  const top = map.getBoundingClientRect().top;
  if (top >= LIST_TOP_OFFSET_PX && top <= window.innerHeight * 0.6) return;
  const still =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({
    top: window.scrollY + top - LIST_TOP_OFFSET_PX,
    behavior: still ? "auto" : "smooth",
  });
}
