"use client";

import { Badge } from "@ratel/design-system/badge";
import { cn } from "@ratel/design-system/cn";
import { DotMeter } from "@ratel/design-system/dot-matrix";
import { NounIcon, TaskPin } from "@ratel/design-system/entity";
import { Section } from "@ratel/design-system/section";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { Tooltip } from "@ratel/design-system/tooltip";
import { CircleX, Flag, type LucideIcon, Plug, RadioTower, Timer, Wrench } from "lucide-react";
import { type ReactNode, useLayoutEffect, useState } from "react";
import {
  chainWeightText,
  NEEDS_FIRST_ADVICE,
  NEEDS_FIRST_EMPTY,
} from "@/components/console/health/journey-copy";
import { PrepaintScript } from "@/components/console/health/PrepaintScript";
import { ToolJourneyCanvas } from "@/components/console/health/ToolJourneyCanvas";
import { FAMILY_COLORS } from "@/components/console/health/ToolJourneyParts";
import {
  SHOW_ALL_ATTRIBUTE,
  SHOW_ALL_KEY,
  SHOW_ALL_SCRIPT,
  SHOW_ALL_STYLE,
} from "@/components/console/health/ToolJourneyView";
import { readStoredFlag, useStoredFlag } from "@/components/console/health/use-stored-flag";
import {
  type CallOrderView,
  chainShareText,
  EVERY_CALL_HINT,
  LANE_HINT,
  LANE_LABEL,
  VIEW_LABELS,
} from "@/components/console/health/v2/call-order-copy";
import { NounTitle } from "@/components/console/health/v2/NounTitle";
import type {
  JourneyChain,
  PrerequisiteReading,
} from "@/lib/readings/trace-signals/flow-journey-insights";
import type { FlowJourney, SourceMode } from "@/lib/readings/trace-signals/view";
import type { JourneyLayout } from "@/lib/views/health/flow-journey-layout";
import type { TaskChain } from "@/lib/views/health/summary/task-chains";

/**
 * What the agent calls first and then: every turn left to right, call by
 * call (the journey drawing), filtered at first to what comes before each
 * tool that almost always needs another; "Every call" brings back the rest.
 * Each view says what it keeps in one line on hover, and the section says
 * which lane it was read from: OpenTelemetry tool spans carry no searches,
 * so the search marks are left out of the key there. Under it, the common
 * chains that are tasks, each lighting its path on the map when the map
 * shows every call. The viewer's choice is kept per browser, as before.
 */

export interface CallOrderProps {
  title: string;
  /** The hover on "What comes before". */
  beforeHint: string;
  /** Some pair crosses turns: the map joins its tools with a dashed link. */
  crossTurn: boolean;
  meta: string;
  lane: SourceMode;
  journey: FlowJourney;
  layout: JourneyLayout;
  /** The common chains that are tasks; empty drops the section. */
  chains: readonly TaskChain[];
  reading: PrerequisiteReading;
  emptyReason: string | null;
  anchors: Readonly<Record<string, readonly string[]>>;
}

export function CallOrder({
  title,
  beforeHint,
  crossTurn,
  meta,
  lane,
  journey,
  layout,
  chains,
  reading,
  emptyReason,
  anchors,
}: CallOrderProps) {
  const [stored, setStored] = useStoredFlag(SHOW_ALL_KEY, false);
  const [chain, setChain] = useState<JourneyChain | null>(null);
  const hasPairs = reading.relations.length > 0;
  const view: CallOrderView = stored || !hasPairs ? "all" : "needs";
  // The pre-paint mark follows what is stored, before paint (see `ToolJourneyView`).
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute(
      SHOW_ALL_ATTRIBUTE,
      readStoredFlag(SHOW_ALL_KEY, false),
    );
  }, [stored]);
  return (
    <>
      <Section
        title={<NounTitle noun="tool">{title}</NounTitle>}
        description={
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <LaneBadge lane={lane} />
            <span className="text-xs text-fg-subtle tabular-nums">{meta}</span>
          </span>
        }
        actions={
          hasPairs ? (
            <SegmentedControl
              label="What the map shows"
              value={view}
              onValueChange={(next) => setStored(next === "all")}
              options={[
                { value: "needs", label: <Hint text={beforeHint}>{VIEW_LABELS.needs}</Hint> },
                { value: "all", label: <Hint text={EVERY_CALL_HINT}>{VIEW_LABELS.all}</Hint> },
              ]}
            />
          ) : null
        }
      >
        <div
          data-flow-card-view={view === "all" ? "all" : "prerequisites"}
          data-tool-flow-map=""
          data-call-order-lane={lane}
        >
          <style dangerouslySetInnerHTML={{ __html: SHOW_ALL_STYLE }} />
          <PrepaintScript name="flow-show-all" code={SHOW_ALL_SCRIPT} />
          {hasPairs ? (
            view === "needs" ? (
              <p
                className="mb-3 flex max-w-3xl items-start gap-2 text-ui text-fg-muted"
                data-prereq-line=""
              >
                <NounIcon noun="fix" className="mt-0.5" />
                <span>{NEEDS_FIRST_ADVICE}</span>
              </p>
            ) : null
          ) : (
            <p className="mb-3 max-w-3xl text-ui text-fg-muted" data-prereq-line="empty">
              {NEEDS_FIRST_EMPTY}
              {emptyReason ? ` ${emptyReason}` : ""}
            </p>
          )}
          <ToolJourneyCanvas
            journey={journey}
            layout={layout}
            anchors={anchors}
            showAll
            filtered={view === "needs"}
            prerequisites={reading.relations}
            chain={view === "all" ? chain : null}
          />
          {view === "all" ? <Legend lane={lane} /> : crossTurn ? <CrossTurnKey /> : null}
        </div>
      </Section>
      {chains.length > 0 ? (
        <Section
          title={<NounTitle noun="task">Common chains</NounTitle>}
          description={`Turns that ran a task's steps exactly, one after another.${view === "all" ? " Point at one to light it on the map." : ""}`}
        >
          <Chains
            chains={chains}
            active={view === "all" ? chain : null}
            onPoint={view === "all" ? setChain : undefined}
          />
        </Section>
      ) : null}
    </>
  );
}

/** A view's name with its one line on hover. */
function Hint({ text, children }: { text: string; children: ReactNode }) {
  return (
    <Tooltip content={text}>
      <span>{children}</span>
    </Tooltip>
  );
}

/** Which lane the reading came from, with what that lane can draw on hover. */
function LaneBadge({ lane }: { lane: SourceMode }) {
  const Icon = lane === "otel" ? RadioTower : Plug;
  return (
    <Tooltip content={LANE_HINT[lane]}>
      <span className="inline-flex" data-call-order-source={lane}>
        <Badge>
          <Icon aria-hidden strokeWidth={1.5} />
          <span className="sr-only">Read from </span>
          {LANE_LABEL[lane]}
        </Badge>
      </span>
    </Tooltip>
  );
}

const STATES: readonly { Icon: LucideIcon; className: string; text: string; searches?: true }[] = [
  { Icon: Wrench, className: "text-danger", text: "Listed often, rarely picked", searches: true },
  { Icon: Wrench, className: "text-warning", text: "Picked from far down", searches: true },
  { Icon: Wrench, className: "text-success", text: "Healthy" },
  { Icon: CircleX, className: "text-danger", text: "Failing" },
  { Icon: Timer, className: "text-warning", text: "Slow" },
];

/** A small key: the map reads without it, this only confirms what a reader guessed. Search marks only where searches arrive. */
function Legend({ lane }: { lane: SourceMode }) {
  const states = lane === "otel" ? STATES.filter((state) => !state.searches) : STATES;
  return (
    <ul
      aria-label="Key"
      className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-subtle"
      data-journey-legend={lane}
    >
      <li className="inline-flex items-center gap-1.5">
        <svg
          aria-hidden
          viewBox={`0 0 ${FAMILY_COLORS.length * 6} 8`}
          className="h-2 shrink-0"
          style={{ width: FAMILY_COLORS.length * 6 }}
        >
          {FAMILY_COLORS.map((color, index) => (
            <rect
              key={color}
              x={index * 6}
              y={0}
              width={4}
              height={8}
              rx={1}
              fill={color}
              fillOpacity={0.85}
            />
          ))}
        </svg>
        Color follows the first tool
      </li>
      <li className="inline-flex items-center gap-1">
        <Flag aria-hidden className="size-3" />
        Ended
      </li>
      {states.map(({ Icon, className, text }) => (
        <li key={text} className="inline-flex items-center gap-1">
          <Icon aria-hidden className={cn("size-3", className)} />
          {text}
        </li>
      ))}
    </ul>
  );
}

/** The one mark the filtered map adds: a dashed link joins two tools called in different turns. */
function CrossTurnKey() {
  return (
    <p
      className="mt-2 inline-flex items-center gap-1.5 text-xs text-fg-subtle"
      data-journey-legend="cross-turn"
    >
      <svg aria-hidden viewBox="0 0 16 2" className="h-0.5 w-4 shrink-0">
        <line
          x1="0"
          y1="1"
          x2="16"
          y2="1"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="3 2"
        />
      </svg>
      Called in different turns
    </p>
  );
}

/** The chains that are tasks: each its task's pin, how many turns ran it and their share. */
function Chains({
  chains,
  active,
  onPoint,
}: {
  chains: readonly TaskChain[];
  active: JourneyChain | null;
  onPoint?: (chain: JourneyChain | null) => void;
}) {
  const most = Math.max(...chains.map((row) => row.chain.share), 0);
  return (
    <ol className="grid grid-cols-1 gap-x-8 md:grid-cols-2" data-journey-chains={chains.length}>
      {chains.map(({ chain, task }) => {
        const key = chain.tools.join(">");
        const on = active?.tools.join(">") === key;
        return (
          <li
            key={task.id}
            data-journey-chain={key}
            data-chain-task={task.id}
            onPointerEnter={onPoint ? () => onPoint(chain) : undefined}
            onPointerLeave={onPoint ? () => onPoint(null) : undefined}
            onFocus={onPoint ? () => onPoint(chain) : undefined}
            onBlur={onPoint ? () => onPoint(null) : undefined}
            className={cn(
              "flex min-h-10 items-center gap-3 border-b border-line px-1 py-2 transition-colors duration-120",
              on ? "bg-selected" : onPoint ? "hover:bg-hover" : null,
            )}
          >
            <span className="flex min-w-0 flex-1">
              <TaskPin name={task.name} slot={task.color} href={task.href} />
            </span>
            <DotMeter
              value={most > 0 ? chain.share / most : 0}
              cells={10}
              tone="neutral"
              label={`${chainShareText(chain.share)} of turns`}
              className="shrink-0 max-sm:hidden"
            />
            <span className="w-28 shrink-0 text-right text-xs text-fg-subtle tabular-nums">
              {chainWeightText(chain)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
