"use client";

import { cn } from "@ratel/design-system/cn";
import { CircleHelp } from "lucide-react";
import { useId, useState } from "react";
import { OpenInTraces } from "@/components/console/health/OpenInTraces";
import { RowChevron } from "@/components/console/health/SignalCard";
import {
  UNSERVED_TITLE,
  unservedRunsText,
  unservedSummary,
} from "@/components/console/health/workflow-copy";
import type { UnservedAskView } from "@/lib/readings/trace-signals/view";

/**
 * Requests no workflow or tool handles, folded into one line at the end of
 * the Workflows section ("3 requests no tool or workflow handles · 19 runs").
 * Open, one line per request: what was asked, how many runs asked for it and
 * one run to open in Traces. The other ways the same request was put sit in
 * the line's tooltip. Each one may need a new tool.
 */
export function UnservedAsks({
  projectId,
  asks,
}: {
  projectId: string;
  asks: readonly UnservedAskView[];
}) {
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  const [touched, setTouched] = useState(false);
  return (
    <div
      data-unserved-asks="true"
      data-unserved-open={open ? "true" : "false"}
      className="mt-3 border-t border-forest-300/60 pt-3"
    >
      <div
        className={cn(
          "group/row rounded-xl transition-colors duration-200",
          open
            ? "bg-forest-600/60"
            : "hover:bg-forest-600/50 has-[>button:focus-visible]:bg-forest-600/50",
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            setTouched(true);
            setOpen(!open);
          }}
          className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left focus-visible:outline-offset-[-2px] sm:px-4"
        >
          <CircleHelp aria-hidden className="size-4 shrink-0 text-ctx-memory" />
          <span
            className="min-w-0 flex-1 text-[13px] font-medium leading-5 text-cream-dim"
            data-unserved-summary="true"
          >
            {unservedSummary(asks)}
          </span>
          <RowChevron open={open} />
        </button>
        <div
          className={cn(
            "grid",
            touched &&
              "transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none",
            open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div id={bodyId} className="min-h-0 min-w-0 overflow-hidden" inert={!open || undefined}>
            <div className="px-3 pb-3 sm:pl-10 sm:pr-4">
              <h3 className="font-mono text-[10px] uppercase tracking-[0.1em] text-warm-muted">
                {UNSERVED_TITLE}
              </h3>
              <ul className="mt-1.5 flex flex-col divide-y divide-forest-300/40">
                {asks.map((ask) => (
                  <AskLine key={ask.title} projectId={projectId} ask={ask} />
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AskLine({ projectId, ask }: { projectId: string; ask: UnservedAskView }) {
  const turnId = ask.turnIds[0];
  const variants = ask.others.length > 0 ? `Also asked as: ${ask.others.join("; ")}` : undefined;
  return (
    <li
      data-unserved-ask="true"
      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2"
    >
      <span className="min-w-0 flex-1 basis-56">
        <span title={variants} className="block truncate text-[13px] leading-5 text-cream">
          {ask.title}
        </span>
        <span className="block text-[12px] leading-5 text-warm-muted">
          {unservedRunsText(ask.runs, ask.reason)}
        </span>
      </span>
      {turnId && (
        <OpenInTraces
          projectId={projectId}
          turn={{ turnId, steps: [] }}
          focusEventId={null}
          compact
        />
      )}
    </li>
  );
}
