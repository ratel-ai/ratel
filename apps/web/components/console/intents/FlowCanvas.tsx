"use client";

import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { usePeek } from "@ratel/design-system/panel";
import { Select } from "@ratel/design-system/select";
import { EmptyState } from "@ratel/design-system/states";
import { TASK_COLOR_CLASSES, type TaskColorSlot } from "@ratel/design-system/task-colors";
import { Info, TriangleAlert, X } from "lucide-react";
import { useMemo, useState } from "react";
import { FlowStepPanel } from "@/components/console/intents/FlowStepPanel";
import { type FlowTopics, startLabel } from "@/components/console/intents/flow-topics";
import { FLOW_KIND_ICON, InfoMark } from "@/components/console/intents/marks";
import type { ExamplesLoad } from "@/components/console/intents/TopicExamples";
import { FLOW_TOPICS_PER_STEP, type FlowStats, type TopicFlows } from "@/lib/readings/topics/types";
import {
  askOrdinal,
  type FlowChip,
  type FlowChipKind,
  type FlowLayout,
  flowNeighbourhood,
  layoutFlow,
} from "@/lib/views/intents/topics-flow-layout";

export type { FlowTopics } from "@/components/console/intents/flow-topics";

const n = (value: number) => value.toLocaleString("en-US");
const pct = (value: number) => `${Math.round(value * 100)}%`;
const PAD = 16;
const EVERYONE = "all";

// A lit ribbon wears its source's task color; written out whole for the compiler.
const RIBBON_LIT: Record<TaskColorSlot, string> = {
  "chart-1": "fill-chart-1/60",
  "chart-5": "fill-chart-5/60",
  "chart-4": "fill-chart-4/60",
};

/** What a screen reader hears before a chip's name. */
const KIND_WORD: Record<FlowChipKind, string> = {
  topic: "Intent: ",
  task: "Task: ",
  tool: "Tool: ",
  retry: "",
  other: "",
  ended: "",
  went_on: "",
};

/** The kinds a legend names, in the order a reader meets them. */
const LEGEND: { kind: FlowChipKind; label: string }[] = [
  { kind: "topic", label: "Intent" },
  { kind: "task", label: "Task" },
  { kind: "tool", label: "Tool" },
  { kind: "retry", label: "Asked again" },
];

/**
 * Flows (DESIGN.md, Data visualization): what people want at each ask of a
 * conversation, the 1st to the 4th, then where it ended. Each step names its
 * busiest few and folds the rest into Other; every chip says its kind by its
 * mark (intent, task, tool). Chips are HTML buttons over an SVG of ribbons, so
 * they read and tab like any control. Ribbons rest in gray; pointing at a chip
 * lights its own in its task's color, and a click (or Enter) opens the step's
 * panel, from where a first ask can be followed. "Start from" and the open
 * step live in the URL (`?start=`, `?step=`). Names are text only: chip ids,
 * values and the URL carry ids.
 */
export function FlowCanvas({
  projectId,
  flows,
  topics,
  note = null,
  loadExamples,
}: {
  projectId: string;
  flows: TopicFlows;
  topics: FlowTopics;
  /** A quiet line over the drawing: what it leaves out. */
  note?: string | null;
  loadExamples: ExamplesLoad;
}) {
  const start = usePeek("start");
  const step = usePeek("step");
  const view = start.id && flows.byStart[start.id] ? start.id : EVERYONE;
  const stats: FlowStats = view === EVERYONE ? flows.all : flows.byStart[view]!;
  const names = useMemo(() => new Map(Object.entries(topics)), [topics]);
  const layout = useMemo(() => layoutFlow(stats, names), [stats, names]);
  const [hover, setHover] = useState<string | null>(null);
  const selected = layout?.chips.some((chip) => chip.id === step.id) ? step.id : null;
  const lit = useMemo(
    () => (layout ? flowNeighbourhood(layout, hover ?? selected) : null),
    [layout, hover, selected],
  );
  const kinds = useMemo(() => new Set(layout?.chips.map((chip) => chip.kind) ?? []), [layout]);

  const follow = (next: string) => {
    if (next === EVERYONE) start.close();
    else start.open(next);
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            aria-hidden
            className={cn("text-xs", view === EVERYONE ? "text-fg-subtle" : "font-medium text-fg")}
          >
            {view === EVERYONE ? "Start from" : "Following"}
          </span>
          <Select
            aria-label="Start from"
            options={[
              { value: EVERYONE, label: "Everyone" },
              ...flows.starts.map((id) => ({ value: id, label: startLabel(id, topics) })),
            ]}
            value={view}
            onValueChange={(next) => {
              step.close();
              follow(next);
            }}
            className="max-w-64 min-w-44"
          />
          {view !== EVERYONE ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                step.close();
                follow(EVERYONE);
              }}
            >
              <X aria-hidden className="size-3.5" />
              Clear
            </Button>
          ) : null}
        </div>
        <FlowLegend kinds={kinds} />
      </div>
      {note ? (
        <p className="flex items-center gap-1.5 text-xs text-fg-subtle">
          <Info aria-hidden strokeWidth={1.5} className="size-3.5 shrink-0" />
          {note}
        </p>
      ) : null}
      {layout ? (
        <FlowDrawing
          layout={layout}
          lit={lit}
          selected={selected}
          onHover={setHover}
          onOpen={step.open}
        />
      ) : (
        <div className="rounded-lg border border-line dot-grid-fade">
          <EmptyState
            emblem
            title="No conversations yet"
            description="Flows appear once people's asks are read."
          />
        </div>
      )}
      <FlowStepPanel
        projectId={projectId}
        layout={layout}
        stats={stats}
        view={view}
        starts={flows.starts}
        chipId={selected}
        topics={topics}
        loadExamples={loadExamples}
        onOpen={step.open}
        onClose={step.close}
        onFollow={follow}
      />
    </div>
  );
}

/** Which mark is which, and how a step is named, one hover away. */
function FlowLegend({ kinds }: { kinds: ReadonlySet<FlowChipKind> }) {
  const shown = LEGEND.filter((item) => item.kind === "topic" || kinds.has(item.kind));
  return (
    <div className="flex items-center gap-1">
      <ul
        aria-label="What each mark is"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle"
      >
        {shown.map((item) => {
          const Icon = FLOW_KIND_ICON[item.kind];
          return (
            <li key={item.kind} className="inline-flex items-center gap-1.5">
              <Icon aria-hidden strokeWidth={1.5} className="size-3.5 shrink-0" />
              {item.label}
            </li>
          );
        })}
      </ul>
      <InfoMark label="How steps are named">
        <div className="flex flex-col gap-1.5">
          <p className="font-medium text-fg">How steps are named</p>
          <p>Each column is one ask of a conversation, in order. An ask is named by its intent.</p>
          <p>
            An ask with no words to read is named by the task your agent ran, or else the first tool
            it called.
          </p>
          <p>{`Each step names its ${FLOW_TOPICS_PER_STEP} busiest; the rest are Other.`}</p>
        </div>
      </InfoMark>
    </div>
  );
}

function FlowDrawing({
  layout,
  lit,
  selected,
  onHover,
  onOpen,
}: {
  layout: FlowLayout;
  lit: { chips: Set<string>; ribbons: Set<string> } | null;
  selected: string | null;
  onHover: (id: string | null) => void;
  onOpen: (id: string) => void;
}) {
  const anyLit = Boolean(lit && lit.chips.size > 0);
  const slotOf = new Map(layout.chips.map((chip) => [chip.id, chip.slot]));
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-app" data-flow-canvas="">
      <div
        className="relative"
        style={{ width: layout.width + 2 * PAD, height: layout.height + 2 * PAD }}
      >
        {layout.columns.map((column) => (
          <p
            key={column.position}
            className="absolute text-xs font-medium text-fg-subtle tabular-nums"
            style={{ left: column.x + PAD, top: PAD }}
          >
            {column.title}
            <span className="ml-1.5 text-fg-faint">{n(column.sessions)}</span>
          </p>
        ))}
        <svg
          aria-hidden
          width={layout.width + 2 * PAD}
          height={layout.height + 2 * PAD}
          className="pointer-events-none absolute inset-0"
        >
          <g transform={`translate(${PAD},${PAD})`}>
            {layout.ribbons.map((ribbon) => {
              const on = lit?.ribbons.has(ribbon.id) ?? false;
              const slot = slotOf.get(ribbon.from) ?? null;
              // At rest every ribbon is gray, so the chips' marks carry the color; a lit one takes its source's task color.
              const paint = ribbon.terminal
                ? on
                  ? "fill-fg/25"
                  : "fill-fg/[0.06]"
                : on
                  ? slot
                    ? RIBBON_LIT[slot]
                    : "fill-fg/35"
                  : "fill-fg/[0.12]";
              return (
                <path
                  key={ribbon.id}
                  d={ribbon.path}
                  className={cn(
                    "transition-opacity duration-120 motion-reduce:transition-none",
                    paint,
                    anyLit && !on && "opacity-40",
                  )}
                />
              );
            })}
          </g>
        </svg>
        {layout.chips.map((chip) => (
          <Chip
            key={chip.id}
            chip={chip}
            state={
              selected === chip.id
                ? "selected"
                : lit?.chips.has(chip.id)
                  ? "lit"
                  : anyLit
                    ? "dim"
                    : "rest"
            }
            onHover={onHover}
            onOpen={onOpen}
          />
        ))}
      </div>
    </div>
  );
}

function Chip({
  chip,
  state,
  onHover,
  onOpen,
}: {
  chip: FlowChip;
  state: "rest" | "lit" | "dim" | "selected";
  onHover: (id: string | null) => void;
  onOpen: (id: string) => void;
}) {
  const style = { left: chip.x + PAD, top: chip.y + PAD, width: chip.w, height: chip.h };
  const Icon = FLOW_KIND_ICON[chip.kind];
  if (chip.kind === "ended" || chip.kind === "went_on") {
    return (
      <div
        className={cn(
          "absolute flex items-center gap-1.5 rounded-md border border-dashed border-line px-2.5 text-xs text-fg-subtle transition-opacity duration-120 motion-reduce:transition-none",
          state === "dim" && "opacity-50",
        )}
        style={style}
      >
        <Icon aria-hidden strokeWidth={1.5} className="size-3 shrink-0" />
        <span className="truncate">{chip.label}</span>
        <span className="ml-auto tabular-nums">{n(chip.sessions)}</span>
      </div>
    );
  }
  const named = chip.kind === "topic" || chip.kind === "task" || chip.kind === "tool";
  const quiet = chip.kind === "retry" || chip.kind === "other";
  return (
    <button
      type="button"
      className={cn(
        "absolute flex flex-col justify-center gap-1 overflow-hidden rounded-md border py-1.5 pr-2.5 pl-3 text-left outline-none",
        "transition-[opacity,border-color,background-color] duration-120 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-focus",
        quiet
          ? "border-dashed border-line-strong bg-app hover:bg-hover"
          : "border-line bg-raised hover:bg-hover",
        state === "selected" && "border-accent-mark bg-selected",
        state === "lit" && "border-line-strong",
        state === "dim" && "opacity-50",
      )}
      style={style}
      aria-pressed={state === "selected"}
      onPointerEnter={() => onHover(chip.id)}
      onPointerLeave={() => onHover(null)}
      onFocus={() => onHover(chip.id)}
      onBlur={() => onHover(null)}
      onClick={() => onOpen(chip.id)}
    >
      {chip.slot ? (
        <span
          aria-hidden
          className={cn("absolute inset-y-0 left-0 w-[3px]", TASK_COLOR_CLASSES[chip.slot].bg)}
        />
      ) : null}
      <span className="flex min-w-0 items-center gap-1.5 text-ui">
        <span className="sr-only">{askOrdinal(chip.position)}: </span>
        <Icon aria-hidden strokeWidth={1.5} className="size-3.5 shrink-0 text-fg-subtle" />
        <span className="sr-only">{KIND_WORD[chip.kind]}</span>
        <span
          className={cn(
            "truncate",
            chip.kind === "tool" && "font-mono text-xs",
            named ? "text-fg" : "text-fg-muted",
          )}
        >
          {chip.label}
        </span>
        {chip.mostlyUnanswered ? (
          <TriangleAlert aria-hidden className="ml-auto size-3 shrink-0 text-warning" />
        ) : null}
      </span>
      <span className="flex items-center gap-1.5 pl-5 text-xs text-fg-subtle tabular-nums">
        <span className="text-fg-muted">{n(chip.sessions)}</span>
        <span className="text-fg-faint">{pct(chip.share)}</span>
        {chip.mostlyUnanswered ? <span className="text-warning">unanswered</span> : null}
      </span>
    </button>
  );
}
