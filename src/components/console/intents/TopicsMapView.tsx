"use client";

import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { DotMeter } from "@ratel/design-system/dot-matrix";
import { NounIcon, TaskPin } from "@ratel/design-system/entity";
import { Panel, usePeek } from "@ratel/design-system/panel";
import {
  TASK_COLOR_CLASSES,
  TASK_COLOR_SLOTS,
  type TaskColorSlot,
} from "@ratel/design-system/task-colors";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { AsksRead } from "@/components/console/intent-map/AsksPack";
import { type IntentMapLayout, IntentMapView } from "@/components/console/intent-map/IntentMapView";
import type { ExamplesLoad } from "@/components/console/intents/TopicExamples";
import { type IntentDetailLoad, TopicPanel } from "@/components/console/intents/TopicPanel";
import { useOnDemand } from "@/components/console/intents/use-on-demand";
import type { IntentAsksTree } from "@/lib/views/intents/asks-tree";
import { capabilityCatalogHref } from "@/lib/views/intents/hrefs";
import {
  capabilityAsks,
  type IntentMapModel,
  type MapCapability,
  type MapTask,
  splitCapabilityKey,
} from "@/lib/views/intents/map/map-model";
import type { ToolStep } from "@/lib/views/intents/map/tool-network";
import { type TopicView, taskHref } from "@/lib/views/intents/topics-view";
import { fixesHref, selfCorrectionsHref } from "@/lib/views/tasks/paths";

const n = (value: number) => value.toLocaleString("en-US");
const pct = (value: number) => `${Math.round(value * 100)}%`;
const count = (value: number, one: string, many: string) =>
  `${n(value)} ${value === 1 ? one : many}`;

/** Reads every intent's asks as a tree, by intent id (`loadIntentAsksAction`). */
export type AsksLoad = () => Promise<
  { ok: true; trees: Record<string, IntentAsksTree> } | { ok: false; message: string }
>;

/** The views a `?view=` names; anything else is the map. */
function layoutOf(view: string | null): IntentMapLayout {
  return view === "asks" || view === "flow" || view === "tools" ? view : "map";
}

/**
 * How much of the window's right edge the Panel covers: `min(36rem, 100vw -
 * 1rem)` wide, `0.5rem` in from the edge (components/ds/panel.tsx). The map
 * keeps an opened node out from under it.
 */
function panelCover(): number {
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return Math.min(36 * rem, window.innerWidth - rem) + 0.5 * rem;
}

/** A tool's searchable description, on Quality › Descriptions. */
export function descriptionHref(projectId: string, toolId: string): string {
  return `/project/${encodeURIComponent(projectId)}/quality/descriptions?tool=${encodeURIComponent(toolId)}`;
}

export interface MapTool {
  calls: number;
  failures: number;
  task: { id: string; name: string; slot: TaskColorSlot | null } | null;
}

/**
 * Intents › Map: every intent as a blob holding the tools its asks used (or
 * its asks nested by what they are for, or the same as a flow, or the tools
 * as a globe of their tasks), with the task colors named underneath as pins.
 * The open node, the lens and where the reader is in the Asks lens live in
 * the URL (`?peek=`, `?view=`, `?in=`); an intent opens the same panel as on
 * All intents, a tool its own. The Asks lens reads its trees the first time
 * it opens (they are people's asks: never part of the page).
 */
export function TopicsMapView({
  projectId,
  model,
  steps,
  topics,
  tools,
  loadExamples,
  loadDetail,
  loadAsks,
}: {
  projectId: string;
  model: IntentMapModel;
  steps: readonly ToolStep[];
  topics: readonly TopicView[];
  /** By capability key (`tool:<id>`, `skill:<id>`). */
  tools: Readonly<Record<string, MapTool>>;
  loadExamples: ExamplesLoad;
  loadDetail: IntentDetailLoad;
  loadAsks: AsksLoad;
}) {
  const peek = usePeek();
  const view = usePeek("view");
  const inside = usePeek("in");
  const layout = layoutOf(view.id);
  const answer = useOnDemand(
    layout === "asks" ? loadAsks : undefined,
    "asks",
    "Couldn't read what these intents' asks are for.",
  );
  const asksRead = useMemo<AsksRead>(
    () =>
      answer.status === "ready"
        ? { status: "ready", trees: new Map(Object.entries(answer.result.trees)) }
        : answer.status === "error"
          ? { status: "failed" }
          : { status: "loading" },
    [answer],
  );
  const order = useMemo(
    () => [
      ...model.asks.map((ask) => ask.id),
      ...model.capabilities.map((capability) => capability.id),
    ],
    [model],
  );
  const isTopic = peek.id !== null && topics.some((topic) => topic.id === peek.id);
  return (
    <>
      <div className="flex flex-col gap-3">
        <IntentMapView
          model={model}
          steps={steps}
          selectedId={peek.id}
          onOpen={peek.open}
          onClear={peek.close}
          layout={layout}
          onLayoutChange={(next) => (next === "map" ? view.close() : view.open(next))}
          obscuredRight={panelCover}
          asks={{
            read: asksRead,
            focus: inside.id,
            onFocus: (key) => (key ? inside.open(key) : inside.close()),
            onOpenIntent: peek.open,
            panelOpen: isTopic,
          }}
        />
        <TaskColors projectId={projectId} model={model} />
      </div>
      <TopicPanel
        topics={topics}
        peekId={isTopic ? peek.id : null}
        order={order}
        loadExamples={loadExamples}
        loadDetail={loadDetail}
        onOpen={peek.open}
        onClose={peek.close}
      />
      <ToolPanel
        projectId={projectId}
        model={model}
        peekId={isTopic ? null : peek.id}
        tools={tools}
        order={order}
        onOpen={peek.open}
        onClose={peek.close}
      />
    </>
  );
}

/**
 * What the colors mean, by name: the tasks wearing the three colors, as pins
 * that open the task, and gray for every other task. Only tasks the drawing
 * colors are named.
 */
export function TaskColors({
  projectId,
  model,
}: {
  projectId: string;
  model: Pick<IntentMapModel, "tasks" | "asks" | "capabilities">;
}) {
  const drawn = new Set(
    [
      ...model.asks.map((ask) => ask.tint),
      ...model.capabilities.map((capability) => capability.tint),
    ].filter(Boolean),
  );
  const colored = TASK_COLOR_SLOTS.flatMap((slot) => {
    const task = (model.tasks ?? []).find((item) => item.slot === slot);
    return task && drawn.has(slot) ? [task] : [];
  });
  const gray = (model.tasks ?? []).some((task: MapTask) => task.slot === null);
  if (colored.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2" data-task-colors="">
      <span className="flex items-center text-xs text-fg-subtle">
        <NounIcon noun="task" />
        <span className="sr-only">Task colors</span>
      </span>
      {colored.map((task) => (
        <TaskPin
          key={task.id}
          name={task.name}
          slot={task.slot}
          href={taskHref(projectId, task.id)}
          className="max-w-[16rem]"
        />
      ))}
      {gray ? (
        <span className="flex items-center gap-1.5 text-xs text-fg-subtle">
          <span
            aria-hidden
            className={cn("size-2 shrink-0 rounded-[2px]", TASK_COLOR_CLASSES.neutral.bg)}
          />
          Other tasks
        </span>
      ) : null}
    </div>
  );
}

function ToolPanel({
  projectId,
  model,
  peekId,
  tools,
  order,
  onOpen,
  onClose,
}: {
  projectId: string;
  model: IntentMapModel;
  peekId: string | null;
  tools: Readonly<Record<string, MapTool>>;
  order: readonly string[];
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const capability = peekId
    ? (model.capabilities.find((item) => item.id === peekId) ?? null)
    : null;
  const [shown, setShown] = useState<MapCapability | null>(capability);
  if (capability && shown !== capability) setShown(capability);
  const index = peekId ? order.indexOf(peekId) : -1;
  const step = (direction: 1 | -1) => {
    const next = order[index + direction];
    if (next) onOpen(next);
  };
  const tool = shown ? tools[shown.id] : undefined;
  const parts = shown ? splitCapabilityKey(shown.id) : null;
  const toolId = parts ? (parts.kind === "skill" ? `skill:${parts.id}` : parts.id) : null;
  return (
    <Panel
      open={capability !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={
        shown ? (
          <span className="flex min-w-0 items-center gap-2">
            <NounIcon noun={shown.kind === "skill" ? "skill" : "tool"} className="size-4" />
            <span className="truncate font-mono">{shown.name}</span>
          </span>
        ) : (
          ""
        )
      }
      subtitle={
        shown
          ? `${count(shown.calls, "call", "calls")} across ${count(shown.asks, "intent", "intents")}`
          : undefined
      }
      onPrevious={index > 0 ? () => step(-1) : undefined}
      onNext={index >= 0 && index < order.length - 1 ? () => step(1) : undefined}
    >
      {shown ? (
        <div className="flex flex-col gap-6" data-panel-kind={shown.kind}>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
            <div className="flex flex-col gap-1">
              <dt className="text-xs text-fg-subtle">Failed calls</dt>
              <dd className="text-ui text-fg tabular-nums">
                {tool ? `${n(tool.failures)} of ${n(tool.calls)}` : "None"}
                {tool && tool.calls > 0 ? (
                  <span className="ml-1.5 text-xs text-fg-subtle">
                    {pct(tool.failures / tool.calls)}
                  </span>
                ) : null}
              </dd>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <dt className="text-xs text-fg-subtle">Main task</dt>
              <dd className="min-w-0 text-ui">
                {tool?.task ? (
                  <TaskPin
                    name={tool.task.name}
                    slot={tool.task.slot}
                    href={taskHref(projectId, tool.task.id)}
                  />
                ) : (
                  <span className="text-fg-muted">No task</span>
                )}
              </dd>
            </div>
          </dl>
          <section className="flex flex-col gap-2">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
              <NounIcon noun="intent" />
              Intents it serves
            </h3>
            <ul className="flex flex-col gap-1.5">
              {capabilityAsks(model, shown.id).map(({ ask, weight }) => (
                <li
                  key={ask.id}
                  className="grid grid-cols-[minmax(0,1fr)_5rem_3rem] items-center gap-3 text-ui"
                >
                  <button
                    type="button"
                    onClick={() => onOpen(ask.id)}
                    className="flex min-w-0 items-center gap-1.5 rounded text-left text-fg outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    <NounIcon noun="intent" className="size-3" />
                    <span className="truncate">{ask.label}</span>
                  </button>
                  <DotMeter
                    value={weight / Math.max(1, shown.calls)}
                    cells={10}
                    tone="neutral"
                    label={`${pct(weight / Math.max(1, shown.calls))} of its calls`}
                  />
                  <span className="text-right text-xs text-fg-muted tabular-nums">{n(weight)}</span>
                </li>
              ))}
            </ul>
          </section>
          {parts && toolId ? (
            <nav aria-label="Its neighbours" className="flex flex-wrap items-center gap-2">
              <Link
                href={capabilityCatalogHref(projectId, parts.kind, parts.id)}
                className={buttonVariants({ variant: "secondary", size: "sm" })}
              >
                Open in Catalog
                <ArrowUpRight aria-hidden className="size-3.5" />
              </Link>
              <Link
                href={descriptionHref(projectId, toolId)}
                className={buttonVariants({ variant: "ghost", size: "sm" })}
              >
                Description
              </Link>
              <Link
                href={selfCorrectionsHref(projectId, { tool: toolId })}
                className={buttonVariants({ variant: "ghost", size: "sm" })}
              >
                <NounIcon noun="selfCorrection" />
                Self-corrections
              </Link>
              <Link
                href={fixesHref(projectId, { tool: toolId })}
                className={buttonVariants({ variant: "ghost", size: "sm" })}
              >
                <NounIcon noun="fix" />
                Fixes
              </Link>
            </nav>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}
