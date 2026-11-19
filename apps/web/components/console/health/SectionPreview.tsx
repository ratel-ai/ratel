"use client";

import { cn } from "@ratel/design-system/cn";
import { ArrowRight } from "lucide-react";
import { createElement, type ReactNode } from "react";
import { type PreviewReason, previewCopy } from "@/components/console/health/section-preview-model";
import { openSetupGuide } from "@/components/console/health/setup-guide-events";
import { WORKFLOW_ROW_GRID } from "@/components/console/health/WorkflowRow";
import { workflowIconComponent } from "@/components/console/health/workflow-icons";
import type { WorkflowIconKey } from "@/lib/readings/trace-signals/workflows/icons";

export interface SectionPreviewProps {
  reason: PreviewReason;
  lane: "sdk" | "otel";
  /** The example the section would show, drawn dimmed behind the message. */
  children: ReactNode;
  className?: string;
  /** A page-level preview standing in for whole sections: no top margin, a larger well. */
  flush?: boolean;
  /** False when the guide is already on screen, so the button would open nothing new. */
  showAction?: boolean;
}

/**
 * A section without the data it needs: its usual layout as an example,
 * dimmed and marked "Example", under what is missing and a button that opens
 * the setup guide for it. The example is decoration (aria-hidden, inert); the
 * message and the button are what a screen reader gets.
 */
export function SectionPreview({
  reason,
  lane,
  children,
  className,
  flush = false,
  showAction = true,
}: SectionPreviewProps) {
  const copy = previewCopy(reason, lane);
  return (
    <div
      data-section-preview={reason}
      className={cn(
        "relative overflow-hidden",
        flush ? "rounded-2xl" : "mt-3 rounded-xl",
        className,
      )}
    >
      <div
        aria-hidden
        inert
        className="pointer-events-none select-none opacity-35 blur-[1.5px] saturate-[0.4]"
      >
        {children}
      </div>
      <span
        aria-hidden
        className="absolute left-3 top-2 rounded-full border border-forest-300 bg-base-deep/80 px-2 py-px font-mono text-[9px] uppercase tracking-[0.12em] text-warm-muted"
      >
        Example
      </span>
      <div
        className={cn(
          "absolute inset-0 flex justify-center p-4",
          flush ? "items-start pt-24" : "items-center",
        )}
      >
        <div className="max-w-md rounded-xl border border-forest-300 bg-base-deep/90 px-4 py-3 text-center shadow-lg backdrop-blur-sm">
          <p className="text-[13px] font-semibold text-cream">{copy.title}</p>
          <p className="mt-1 text-[12px] leading-5 text-warm-muted">{copy.body}</p>
          {showAction && (
            <button
              type="button"
              onClick={() => openSetupGuide(copy.setupKey)}
              data-preview-action={copy.setupKey}
              className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-cream/30 px-2.5 py-1 text-[12px] font-medium text-cream outline-none transition-colors hover:border-cream hover:bg-cream hover:text-ink focus-visible:ring-2 focus-visible:ring-coral/60"
            >
              {copy.action}
              <ArrowRight aria-hidden className="size-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface SampleRow {
  icon: WorkflowIconKey;
  name: string;
  status: string;
  tone: "coral" | "blue" | "grey";
  runs: string;
  finish: string;
}

const SAMPLE_ROWS: readonly SampleRow[] = [
  {
    icon: "rocket",
    name: "Close out a release",
    status: "Failing",
    tone: "coral",
    runs: "412",
    finish: "61%",
  },
  {
    icon: "calendar",
    name: "Plan the next sprint",
    status: "Build this",
    tone: "blue",
    runs: "268",
    finish: "94%",
  },
  {
    icon: "bug",
    name: "Triage a new bug",
    status: "Healthy",
    tone: "grey",
    runs: "190",
    finish: "97%",
  },
  {
    icon: "users",
    name: "Onboard a teammate",
    status: "Healthy",
    tone: "grey",
    runs: "88",
    finish: "99%",
  },
];

const TONE: Readonly<Record<SampleRow["tone"], string>> = {
  coral: "border-coral/40 bg-coral/10 text-coral",
  blue: "border-ctx-memory/40 bg-ctx-memory/10 text-ctx-memory",
  grey: "border-forest-300 bg-forest-600/60 text-warm-muted",
};

/** Four made-up workflows in the real row layout: what the section looks like with data. */
export function WorkflowPreviewRows() {
  return (
    <ul className="flex flex-col gap-1.5 pb-1 pt-7">
      {SAMPLE_ROWS.map((row) => (
        <li
          key={row.name}
          className={cn(WORKFLOW_ROW_GRID, "rounded-xl bg-forest-600/30 px-3 py-2.5 sm:px-4")}
        >
          {createElement(workflowIconComponent(row.icon), { className: "size-4 text-warm-muted" })}
          <span className="truncate text-[14px] font-medium text-cream">{row.name}</span>
          <span className="hidden sm:flex">
            <span
              className={cn(
                "whitespace-nowrap rounded-full border px-2 py-px text-[11px] font-medium",
                TONE[row.tone],
              )}
            >
              {row.status}
            </span>
          </span>
          <span className="text-right text-[13px] tabular-nums text-cream-dim">{row.runs}</span>
          <span className="text-right font-display text-[15px] font-semibold tabular-nums text-cream">
            {row.finish}
          </span>
          <span />
        </li>
      ))}
    </ul>
  );
}

/** Two made-up requests no workflow handles, in the unserved line's shape. */
export function UnservedPreviewRows() {
  return (
    <ul className="flex flex-col gap-1.5 pb-1 pt-7">
      {["export the board as a PDF", "move every overdue task to next week"].map((ask) => (
        <li
          key={ask}
          className="flex items-center justify-between rounded-xl bg-forest-600/30 px-3 py-2 text-[13px] text-cream-dim sm:px-4"
        >
          <span className="truncate">&ldquo;{ask}&rdquo;</span>
          <span className="shrink-0 pl-3 text-[12px] text-warm-muted">No tool does this</span>
        </li>
      ))}
    </ul>
  );
}
