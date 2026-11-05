"use client";

import { Badge } from "@ratel/design-system/badge";
import { IconButton } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { Section } from "@ratel/design-system/section";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SessionView, ViewRow } from "@/lib/views/session-replay/view";
import { ContextBar, ContextLens, Markers } from "./ContextLens";
import { DecisionChip } from "./DecisionChip";

/**
 * The session as a scrubbable timeline: a slider and a strip of every step
 * on top, the steps in order on the left, and on the right the context lens
 * of the model call the current step sits in. Coral marks the current step
 * only (DESIGN.md, Brand).
 */

const COVERAGE_BADGE: Record<
  ViewRow["coverage"],
  { label: string; tone: "neutral" | "warning" } | null
> = {
  content: null,
  tokens_only: { label: "Tokens only", tone: "neutral" },
  expired: { label: "Expired", tone: "warning" },
};

export function SessionTimeline({ view }: { view: SessionView }) {
  const total = view.rows.length;
  const [current, setCurrent] = useState(
    () => view.rows.find((row) => row.chips.some((chip) => chip.tone === "bad"))?.index ?? 1,
  );
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-step="${current}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [current]);
  const row = view.rows[current - 1] ?? null;
  const lensRow = row?.lensStep ? (view.rows[row.lensStep - 1] ?? null) : null;
  const go = (index: number) => setCurrent(Math.min(total, Math.max(1, index)));

  return (
    <Section title="Timeline" description="Move through the session one step at a time.">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <IconButton
            label="Previous step"
            icon={<ChevronLeft aria-hidden className="size-4" strokeWidth={1.5} />}
            onClick={() => go(current - 1)}
            disabled={current <= 1}
          />
          <input
            type="range"
            min={1}
            max={total}
            value={current}
            onChange={(event) => go(Number(event.target.value))}
            aria-label="Step"
            aria-valuetext={`Step ${current} of ${total}`}
            className="h-1 flex-1 cursor-pointer accent-accent-mark"
          />
          <IconButton
            label="Next step"
            icon={<ChevronRight aria-hidden className="size-4" strokeWidth={1.5} />}
            onClick={() => go(current + 1)}
            disabled={current >= total}
          />
          <span className="w-28 text-right text-ui text-fg-muted tabular-nums">
            Step {current} of {total}
          </span>
        </div>
        <StepStrip rows={view.rows} current={current} onPick={go} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <ol
          ref={listRef}
          aria-label="Steps"
          className="flex max-h-[70vh] flex-col gap-1 overflow-y-auto pr-1"
        >
          {view.rows.map((step) => (
            <StepRow
              key={step.index}
              row={step}
              selected={step.index === current}
              onPick={() => go(step.index)}
            />
          ))}
        </ol>
        <aside
          className="self-start rounded-lg border border-line bg-raised p-4 lg:sticky lg:top-4"
          aria-label="Context lens"
        >
          <ContextLens row={lensRow} gaps={view.gaps} />
        </aside>
      </div>
    </Section>
  );
}

/** One cell per step; a dot under a step flags a questionable choice or a marker. */
function StepStrip({
  rows,
  current,
  onPick,
}: {
  rows: readonly ViewRow[];
  current: number;
  onPick: (index: number) => void;
}) {
  return (
    <div className="flex w-full gap-[2px]" aria-hidden>
      {rows.map((row) => {
        const bad = row.chips.some((chip) => chip.tone === "bad");
        const flagged = row.markers.length > 0 || row.marks.length > 0;
        return (
          <button
            key={row.index}
            type="button"
            tabIndex={-1}
            onClick={() => onPick(row.index)}
            className="group flex min-w-[3px] flex-1 flex-col items-center gap-1 py-1"
          >
            <span
              className={cn(
                "h-3 w-full rounded-[1px]",
                row.index === current
                  ? "bg-accent-mark"
                  : row.kind === "turn"
                    ? "bg-line-active"
                    : "bg-line group-hover:bg-line-strong",
              )}
            />
            <span
              className={cn(
                "size-1 rounded-full",
                bad ? "bg-danger" : flagged ? "bg-warning" : "bg-transparent",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}

function StepRow({
  row,
  selected,
  onPick,
}: {
  row: ViewRow;
  selected: boolean;
  onPick: () => void;
}) {
  const coverage = COVERAGE_BADGE[row.coverage];
  return (
    <li
      data-step={row.index}
      data-step-kind={row.kind}
      className={cn(row.kind === "turn" && row.index > 1 && "mt-3")}
    >
      <div
        role="button"
        tabIndex={0}
        aria-current={selected ? "step" : undefined}
        onClick={onPick}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onPick();
          }
        }}
        className={cn(
          "flex cursor-pointer flex-col gap-2 rounded-md px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-focus",
          selected ? "bg-selected" : "hover:bg-hover",
          row.kind !== "turn" && "ml-4",
        )}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span
            className={cn(
              "w-7 shrink-0 font-mono text-xs tabular-nums",
              selected ? "text-accent-mark" : "text-fg-subtle",
            )}
          >
            {row.index}
          </span>
          <span
            className={cn(
              "min-w-0 truncate text-ui",
              row.kind === "turn" ? "font-semibold text-fg" : "text-fg",
            )}
          >
            {row.title}
          </span>
          {row.marks.map((mark) => (
            <Badge key={mark.code} tone={mark.code === "abandoned" ? "danger" : "warning"}>
              {mark.label}
            </Badge>
          ))}
          {coverage ? <Badge tone={coverage.tone}>{coverage.label}</Badge> : null}
          {row.detail ? (
            <span className="ml-auto text-xs text-fg-subtle tabular-nums">{row.detail}</span>
          ) : null}
        </div>
        {row.bar ? <ContextBar bar={row.bar} className="ml-10 w-auto" /> : null}
        {row.markers.length > 0 || row.chips.length > 0 ? (
          <div className="ml-10 flex flex-col gap-1.5">
            <Markers markers={row.markers} />
            {row.chips.map((chip, i) => (
              <DecisionChip key={i} chip={chip} />
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
}
