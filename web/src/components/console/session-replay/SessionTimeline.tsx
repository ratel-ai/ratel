"use client";

import { Badge } from "@ratel/design-system/badge";
import { IconButton } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { Section } from "@ratel/design-system/section";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { memo, type Ref, useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import type { StepText } from "@/lib/views/session-replay/settings";
import type { SessionView, ViewRow } from "@/lib/views/session-replay/view";
import type { WhatIfOptions, WhatIfRunView } from "@/lib/views/session-replay/what-if";
import { ContextBar, ContextLens, Markers } from "./ContextLens";
import { DecisionChip } from "./DecisionChip";
import { PanelBoundary } from "./PanelBoundary";
import { type ForkTarget, WhatIfPanel } from "./WhatIfPanel";

/**
 * The session as a scrubbable timeline: a slider and a strip of every step
 * on top, the steps in order on the left, and on the right the context lens
 * of the model call the current step sits in, with that call's message text
 * when the page was given it (the content opt-in is on), and What if… to
 * fork that call with a change. Coral marks the current step only (DESIGN.md, Brand).
 */

/** What the What-if panel needs: the forkable model calls by step index, the changes on offer and the session's runs. */
export interface WhatIfSetup {
  projectId: string;
  targets: Readonly<Record<number, ForkTarget>>;
  options: WhatIfOptions;
  runs: readonly WhatIfRunView[];
  readContent: boolean;
}

const COVERAGE_BADGE: Record<
  ViewRow["coverage"],
  { label: string; tone: "neutral" | "warning" } | null
> = {
  content: null,
  tokens_only: { label: "Tokens only", tone: "neutral" },
  expired: { label: "Expired", tone: "warning" },
};

export function SessionTimeline({
  view,
  texts = {},
  whatIf,
}: {
  view: SessionView;
  texts?: Readonly<Record<number, StepText>>;
  whatIf?: WhatIfSetup;
}) {
  const total = view.rows.length;
  const [current, setCurrent] = useState(
    () => view.rows.find((row) => row.chips.some((chip) => chip.tone === "bad"))?.index ?? 1,
  );
  // RTL-368: the slider and its label read `current`; the strip, the list and the lens read a
  // deferred copy, so dragging stays instant while they catch up.
  const shown = useDeferredValue(current);
  const listRef = useRef<HTMLOListElement>(null);
  // The list scrolls to the step when someone lands on it, never on each tick of a drag.
  // A new object each time, so landing again on the same step scrolls to it again.
  const [reveal, setReveal] = useState<{ step: number } | null>(null);
  useEffect(() => {
    if (reveal === null) return;
    listRef.current
      ?.querySelector(`[data-step="${reveal.step}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [reveal]);
  const row = view.rows[shown - 1] ?? null;
  const lensRow = row?.lensStep ? (view.rows[row.lensStep - 1] ?? null) : null;
  const clamp = useCallback((index: number) => Math.min(total, Math.max(1, index)), [total]);
  const go = useCallback(
    (index: number) => {
      setCurrent(clamp(index));
      setReveal({ step: clamp(index) });
    },
    [clamp],
  );

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
            onChange={(event) => setCurrent(clamp(Number(event.target.value)))}
            onPointerUp={() => setReveal({ step: current })}
            onKeyUp={() => setReveal({ step: current })}
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
        <StepStrip rows={view.rows} current={shown} onPick={go} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <StepList ref={listRef} rows={view.rows} current={shown} onPick={go} />
        <aside
          className="self-start rounded-lg border border-line bg-raised p-4 lg:sticky lg:top-4"
          aria-label="Context lens"
        >
          <PanelBoundary name="context lens" resetKey={lensRow?.index ?? null}>
            <ContextLens row={lensRow} gaps={view.gaps} />
            {lensRow && texts[lensRow.index] ? <StepMessages text={texts[lensRow.index]!} /> : null}
          </PanelBoundary>
          {lensRow && whatIf?.targets[lensRow.index] ? (
            <PanelBoundary name="What if… panel" resetKey={lensRow.index}>
              <WhatIfPanel
                key={lensRow.index}
                projectId={whatIf.projectId}
                target={whatIf.targets[lensRow.index]!}
                options={whatIf.options}
                runs={whatIf.runs}
                readContent={whatIf.readContent}
              />
            </PanelBoundary>
          ) : null}
        </aside>
      </div>
    </Section>
  );
}

/** Every step in order; memo'd, so a slider tick that the deferred step has not reached skips it. */
const StepList = memo(function StepList({
  ref,
  rows,
  current,
  onPick,
}: {
  ref: Ref<HTMLOListElement>;
  rows: readonly ViewRow[];
  current: number;
  onPick: (index: number) => void;
}) {
  return (
    <ol
      ref={ref}
      aria-label="Steps"
      className="flex max-h-[70vh] flex-col gap-1 overflow-y-auto pr-1"
    >
      {rows.map((step) => (
        <StepRow
          key={step.index}
          row={step}
          selected={step.index === current}
          onPick={() => onPick(step.index)}
        />
      ))}
    </ol>
  );
});

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

/** The message text of the model call in the lens: its system prompt and last messages, each cut short. */
function StepMessages({ text }: { text: StepText }) {
  return (
    <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4" aria-label="Message text">
      <h3 className="text-xs font-medium text-fg-muted">Message text</h3>
      {text.system ? <MessageBlock role="system" text={text.system} /> : null}
      {text.omitted > 0 ? (
        <p className="text-xs text-fg-subtle">
          {text.omitted} earlier {text.omitted === 1 ? "message" : "messages"} not shown.
        </p>
      ) : null}
      {text.messages.map((message, i) => (
        <MessageBlock key={i} role={message.role} text={message.text} />
      ))}
    </div>
  );
}

function MessageBlock({ role, text }: { role: string; text: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-xs text-fg-subtle">{role}</span>
      <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-ui text-fg">
        {text}
      </p>
    </div>
  );
}
