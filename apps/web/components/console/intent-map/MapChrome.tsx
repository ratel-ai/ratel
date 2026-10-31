"use client";

import { NounIcon, ToolPin } from "@ratel/design-system/entity";
import { useLayoutEffect, useRef, useState } from "react";
import { BADGE_RADIUS } from "@/components/console/intent-map/MapMarks";
import type { ToolMark } from "@/lib/views/intents/map/map-marks";
import {
  type MapAsk,
  type MapCapability,
  type MapProblem,
  problemWord,
} from "@/lib/views/intents/map/map-model";
import { cardSpot, type ScreenBox } from "@/lib/views/intents/map/tool-network-layout";

type Readout =
  | { kind: "ask"; ask: MapAsk; tools: number }
  | { kind: "capability"; capability: MapCapability }
  | null;

const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * One quiet line in the corner: what the lit intent or tool is, in numbers,
 * led by its noun's icon. It follows hover and keyboard focus and is announced
 * politely, so the map reads the same without a pointer. The panel has the
 * rest.
 */
export function MapReadout({
  readout,
  hidden,
  totals,
}: {
  readout: Readout;
  hidden: { asks: number; volume: number } | null;
  totals: { asks: number; capabilities: number };
}) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none absolute bottom-3 left-3 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border border-line bg-raised px-2.5 py-1.5 text-xs text-fg-muted md:max-w-[min(34rem,calc(100%-22rem))]"
    >
      {readout?.kind === "ask" ? (
        <>
          <NounIcon noun="intent" />
          <span className="min-w-0 truncate font-medium text-fg">{readout.ask.label}</span>
          <span className="tabular-nums">{count(readout.ask.volume, "ask", "asks")}</span>
          <span className="tabular-nums">{count(readout.tools, "tool", "tools")}</span>
          {readout.ask.problem ? (
            <span className="text-warning">{problemWord(readout.ask.problem)}</span>
          ) : null}
        </>
      ) : readout?.kind === "capability" ? (
        <>
          <NounIcon noun={readout.capability.kind === "skill" ? "skill" : "tool"} />
          <span className="min-w-0 truncate font-mono text-fg">{readout.capability.name}</span>
          <span className="tabular-nums">{count(readout.capability.calls, "call", "calls")}</span>
          <span className="tabular-nums">
            {count(readout.capability.asks, "intent", "intents")}
          </span>
          {readout.capability.missing ? (
            <span className="text-warning">Not in your catalog</span>
          ) : null}
        </>
      ) : (
        <>
          <NounIcon noun="intent" />
          <span className="tabular-nums">{count(totals.asks, "intent", "intents")}</span>
          <NounIcon noun="tool" className="ml-1" />
          <span className="tabular-nums">{count(totals.capabilities, "tool", "tools")}</span>
          {hidden ? (
            <span className="tabular-nums">
              {count(hidden.asks, "quieter intent", "quieter intents")} in All intents
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}

/** What the marks mean. Only the marks this map uses. */
export function MapLegend({
  problem,
  tinted,
  missing,
  skills,
  shared,
}: {
  /** A problem some intent has, to name its warning mark; null when none has one. */
  problem: MapProblem | null;
  /** Whether some intent or tool wears its main task's color. */
  tinted: boolean;
  missing: boolean;
  skills: boolean;
  /** Whether some tool has a mark in more than one intent. */
  shared: boolean;
}) {
  return (
    <ul
      aria-label="Legend"
      className="pointer-events-none absolute right-3 bottom-3 hidden items-center gap-3 rounded-md border border-line bg-raised px-2.5 py-1.5 text-xs text-fg-subtle md:flex"
    >
      <li className="flex items-center gap-1.5">
        <svg aria-hidden width="14" height="12" viewBox="0 0 14 12">
          <ellipse cx="7" cy="6" rx="6.5" ry="5.5" className="fill-fg/[0.06] stroke-line-strong" />
        </svg>
        Intent
      </li>
      <li className="flex items-center gap-1.5">
        <svg aria-hidden width="8" height="8" viewBox="0 0 8 8">
          <circle cx="4" cy="4" r="3.5" className="fill-fg-subtle" />
        </svg>
        Tool
      </li>
      {shared ? (
        <li className="flex items-center gap-1.5">
          <svg aria-hidden width="12" height="12" viewBox="0 0 12 12">
            <circle
              cx="6"
              cy="6"
              r="5.25"
              className="fill-none stroke-fg-faint [stroke-width:1px]"
            />
            <circle cx="6" cy="6" r="3" className="fill-fg-subtle" />
          </svg>
          In several intents
        </li>
      ) : null}
      {skills ? (
        <li className="flex items-center gap-1.5">
          <svg aria-hidden width="8" height="8" viewBox="0 0 8 8">
            <rect x="0.5" y="0.5" width="7" height="7" rx="2" className="fill-fg-subtle" />
          </svg>
          Skill
        </li>
      ) : null}
      {tinted ? (
        <li className="flex items-center gap-1.5">
          <svg aria-hidden width="22" height="8" viewBox="0 0 22 8">
            <circle cx="4" cy="4" r="3.5" className="fill-chart-1" />
            <circle cx="11" cy="4" r="3.5" className="fill-chart-5" />
            <circle cx="18" cy="4" r="3.5" className="fill-chart-4" />
          </svg>
          Task
        </li>
      ) : null}
      {missing ? (
        <li className="flex items-center gap-1.5">
          <svg aria-hidden width="8" height="8" viewBox="0 0 8 8">
            <circle
              cx="4"
              cy="4"
              r="3"
              className="fill-app stroke-fg-subtle [stroke-dasharray:2_2]"
            />
          </svg>
          Not in catalog
        </li>
      ) : null}
      {problem ? (
        <li className="flex items-center gap-1.5">
          <svg
            aria-hidden
            width={BADGE_RADIUS * 2}
            height={BADGE_RADIUS * 2}
            viewBox={`0 0 ${BADGE_RADIUS * 2} ${BADGE_RADIUS * 2}`}
          >
            <circle
              cx={BADGE_RADIUS}
              cy={BADGE_RADIUS}
              r={BADGE_RADIUS - 0.5}
              className="fill-app stroke-warning [stroke-width:1px]"
            />
            <path
              d={`M${BADGE_RADIUS},${BADGE_RADIUS - 4.5}L${BADGE_RADIUS + 4.5},${BADGE_RADIUS + 3.5}L${BADGE_RADIUS - 4.5},${BADGE_RADIUS + 3.5}Z`}
              className="fill-warning"
            />
          </svg>
          {problemWord(problem)}
        </li>
      ) : null}
    </ul>
  );
}

/** The most tools an intent's card lists before it counts the rest. */
export const CARD_TOOLS = 6;

/**
 * An intent's tools, beside its blob while it is pointed at or focused: each
 * a pin with its calls, busiest first, a shared one marked. For the eye only
 * (the readout announces the intent); names are text, never attributes.
 */
export function IntentCard({
  ask,
  marks,
  capabilities,
  blob,
  view,
}: {
  ask: MapAsk;
  /** The intent's marks, busiest first. */
  marks: readonly ToolMark[];
  capabilities: ReadonlyMap<string, MapCapability>;
  /** The blob's box on screen. */
  blob: ScreenBox;
  /** The canvas, to keep the card inside it. */
  view: { width: number; height: number };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const next = cardSpot(blob, { width: element.offsetWidth, height: element.offsetHeight }, view);
    setSpot((current) =>
      current && current.left === next.left && current.top === next.top ? current : next,
    );
  }, [blob, view]);
  const shown = marks.slice(0, CARD_TOOLS);
  const more = marks.length - shown.length;
  return (
    <div
      ref={ref}
      aria-hidden
      data-intent-card=""
      className="pointer-events-none absolute z-sticky flex w-64 flex-col gap-2 rounded-lg border border-line bg-overlay p-2.5 text-xs text-fg-muted shadow-overlay"
      // Placed once measured; until then it takes its size out of sight.
      style={spot ?? { left: 0, top: 0, visibility: "hidden" }}
    >
      <p className="flex min-w-0 items-center gap-1.5">
        <NounIcon noun="intent" />
        <span className="min-w-0 truncate font-medium text-fg">{ask.label}</span>
        <span className="ml-auto shrink-0 tabular-nums">{count(ask.volume, "ask", "asks")}</span>
      </p>
      {shown.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {shown.map((mark) => {
            const capability = capabilities.get(mark.capability);
            if (!capability) return null;
            return (
              <li key={mark.id} className="flex min-w-0 items-center gap-2">
                <ToolPin
                  name={capability.name}
                  kind={capability.kind === "skill" ? "skill" : "tool"}
                  missing={capability.missing}
                  className="max-w-[11rem]"
                />
                {mark.shared ? (
                  <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" className="shrink-0">
                    <circle
                      cx="6"
                      cy="6"
                      r="5.25"
                      className="fill-none stroke-fg-faint [stroke-width:1px]"
                    />
                    <circle cx="6" cy="6" r="3" className="fill-fg-subtle" />
                  </svg>
                ) : null}
                <span className="ml-auto shrink-0 tabular-nums">
                  {mark.weight.toLocaleString("en-US")}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p>No tool ran for its asks</p>
      )}
      {more > 0 ? (
        <p className="tabular-nums">and {count(more, "more tool", "more tools")}</p>
      ) : null}
    </div>
  );
}
