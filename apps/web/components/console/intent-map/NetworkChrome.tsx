"use client";

import { NounIcon } from "@ratel/design-system/entity";
import { useLayoutEffect, useRef, useState } from "react";
import { BADGE_RADIUS } from "@/components/console/intent-map/MapMarks";
import type { Point } from "@/lib/views/intents/map/map-geometry";
import type { NetworkLink, NetworkNode } from "@/lib/views/intents/map/tool-network";
import { explanationSpot, type ScreenBox } from "@/lib/views/intents/map/tool-network-layout";

/** Where a tool lives, for the readout: a task (its name is text only), Shared, or Other. */
export type ReadoutHome = { kind: "task" | "group" | "shared" | "other"; name: string } | null;

export type NetworkReadoutState =
  | { kind: "node"; node: NetworkNode; partners: readonly string[]; home?: ReadoutHome }
  | { kind: "link"; link: NetworkLink; names: [string, string]; reasons: readonly string[] }
  | null;

const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * One quiet line in the corner, like the map's: what the lit tool or link is,
 * in numbers and words, led by its noun's icon. It follows hover and keyboard
 * focus and is announced politely, so a keyboard reader learns a tool's home
 * and partners without a pointer.
 */
export function NetworkReadout({
  readout,
  totals,
}: {
  readout: NetworkReadoutState;
  totals: { tools: number; links: number; shown: number; tasks?: number };
}) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none absolute bottom-3 left-3 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border border-line bg-raised px-2.5 py-1.5 text-xs text-fg-muted md:max-w-[min(40rem,calc(100%-24rem))]"
    >
      {readout?.kind === "node" ? (
        <>
          <NounIcon noun={readout.node.kind === "skill" ? "skill" : "tool"} />
          <span className="min-w-0 truncate font-mono text-fg">{readout.node.name}</span>
          <span className="tabular-nums">{count(readout.node.calls, "call", "calls")}</span>
          <span className="tabular-nums">{count(readout.node.asks, "intent", "intents")}</span>
          {readout.home ? (
            <span className="flex min-w-0 items-center gap-1">
              {readout.home.kind === "task" ? <NounIcon noun="task" /> : null}
              <span className="truncate">
                {readout.home.kind === "shared"
                  ? "Shared by many tasks"
                  : readout.home.kind === "other"
                    ? "No task"
                    : readout.home.name}
              </span>
            </span>
          ) : readout.node.hub ? (
            <span>Widely shared</span>
          ) : null}
          {readout.partners.length > 0 ? (
            <span className="min-w-0 truncate">
              With <span className="font-mono">{readout.partners.join(", ")}</span>
              {readout.node.partners > readout.partners.length
                ? ` and ${readout.node.partners - readout.partners.length} more`
                : ""}
            </span>
          ) : (
            <span>No links</span>
          )}
          {readout.node.missing ? <span className="text-warning">Not in your catalog</span> : null}
        </>
      ) : readout?.kind === "link" ? (
        <>
          <span className="truncate font-mono text-fg">
            {readout.names[0]} and {readout.names[1]}
          </span>
          {readout.reasons.map((reason) => (
            <span key={reason} className="min-w-0 truncate">
              {reason}
            </span>
          ))}
        </>
      ) : (
        <>
          <NounIcon noun="tool" />
          <span className="tabular-nums">{count(totals.tools, "tool", "tools")}</span>
          {totals.tasks ? (
            <>
              <NounIcon noun="task" className="ml-1" />
              <span className="tabular-nums">{count(totals.tasks, "task", "tasks")}</span>
            </>
          ) : null}
          <span className="tabular-nums">
            {totals.shown < totals.links ? `${totals.shown.toLocaleString("en-US")} of ` : ""}
            {count(totals.links, "link", "links")}
          </span>
        </>
      )}
    </div>
  );
}

/**
 * Why two tools are linked, beside the link the pointer is on: it measures
 * itself, then takes the first spot around the link's middle that keeps both
 * tools and their names in sight (`explanationSpot`). Visible text only (ask
 * labels are user text and stay out of attributes); the readout announces
 * the same words, so this one is hidden from assistive tech.
 */
export function LinkExplanation({
  names,
  reasons,
  anchor,
  avoid,
  view,
}: {
  names: [string, string];
  reasons: readonly string[];
  /** The link's middle on screen. */
  anchor: Point;
  /** What it should not cover: the two tools and their names, on screen. */
  avoid: readonly ScreenBox[];
  /** The canvas, to keep the box inside it. */
  view: { width: number; height: number };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const next = explanationSpot(
      anchor,
      { width: element.offsetWidth, height: element.offsetHeight },
      avoid,
      view,
    );
    setSpot((current) =>
      current && current.left === next.left && current.top === next.top ? current : next,
    );
  }, [anchor, avoid, view]);
  return (
    <div
      ref={ref}
      aria-hidden
      data-link-explanation=""
      className="pointer-events-none absolute z-sticky w-72 rounded-md border border-line bg-overlay px-2.5 py-1.5 text-xs text-fg-muted shadow-overlay"
      // Placed once measured; until then it takes its size out of sight.
      style={spot ?? { left: 0, top: 0, visibility: "hidden" }}
    >
      <p className="font-mono text-fg">
        {names[0]} and {names[1]}
      </p>
      {reasons.map((reason) => (
        <p key={reason} className="mt-0.5">
          {reason}
        </p>
      ))}
    </div>
  );
}

/** What the marks mean. Only the marks this drawing uses. */
export function NetworkLegend({
  groups,
  colorLabel = "Task",
  hubs,
  hubLabel = "Shared by many tasks",
  other = false,
  ordered,
  missing,
  skills,
}: {
  /** Whether some home or group wears a hue. */
  groups: boolean;
  /** What the hues mean: a task, or tools run together. */
  colorLabel?: string;
  /** Whether some tool wears the ring: shared by many tasks, or a hub. */
  hubs: boolean;
  hubLabel?: string;
  /** Whether some tools sit on the Other ring. */
  other?: boolean;
  /** Whether some link has an order. */
  ordered: boolean;
  missing: boolean;
  skills: boolean;
}) {
  return (
    <ul
      aria-label="Legend"
      className="pointer-events-none absolute right-3 bottom-3 hidden items-center gap-3 rounded-md border border-line bg-raised px-2.5 py-1.5 text-xs text-fg-subtle md:flex"
    >
      <li className="flex items-center gap-1.5">
        <svg aria-hidden width="8" height="8" viewBox="0 0 8 8">
          <circle cx="4" cy="4" r="3.5" className="fill-fg-subtle" />
        </svg>
        Tool
      </li>
      {skills ? (
        <li className="flex items-center gap-1.5">
          <svg aria-hidden width="8" height="8" viewBox="0 0 8 8">
            <rect x="0.5" y="0.5" width="7" height="7" rx="2" className="fill-fg-subtle" />
          </svg>
          Skill
        </li>
      ) : null}
      {groups ? (
        <li className="flex items-center gap-1.5">
          <svg aria-hidden width="22" height="8" viewBox="0 0 22 8">
            <rect x="0.5" y="0.5" width="7" height="7" rx="2" className="fill-chart-1" />
            <rect x="7.5" y="0.5" width="7" height="7" rx="2" className="fill-chart-5" />
            <rect x="14.5" y="0.5" width="7" height="7" rx="2" className="fill-chart-4" />
          </svg>
          {colorLabel}
        </li>
      ) : null}
      {hubs ? (
        <li className="flex items-center gap-1.5">
          <svg aria-hidden width="12" height="12" viewBox="0 0 12 12">
            <circle
              cx="6"
              cy="6"
              r="5.25"
              className="fill-none stroke-fg-faint [stroke-width:1.5px]"
            />
            <circle cx="6" cy="6" r="3" className="fill-fg-subtle" />
          </svg>
          {hubLabel}
        </li>
      ) : null}
      {other ? (
        <li className="flex items-center gap-1.5">
          <svg aria-hidden width="10" height="10" viewBox="0 0 10 10">
            <circle
              cx="5"
              cy="5"
              r="4.25"
              className="fill-none stroke-fg-subtle [stroke-dasharray:2_2] [stroke-width:1px]"
            />
          </svg>
          No task
        </li>
      ) : null}
      {ordered ? (
        <li className="flex items-center gap-1.5">
          <svg aria-hidden width="18" height="8" viewBox="0 0 18 8">
            <path d="M1 4H11" className="fill-none stroke-fg-faint [stroke-width:1.5px]" />
            <path d="M17 4L11 1V7Z" className="fill-fg-faint" />
          </svg>
          Came next
        </li>
      ) : null}
      {missing ? (
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
          Not in catalog
        </li>
      ) : null}
    </ul>
  );
}

/** The readout's line for a tool: its strongest partners by name, at most `limit`. */
export function strongestPartners(
  id: string,
  links: readonly NetworkLink[],
  nameOf: (id: string) => string,
  limit = 3,
): string[] {
  return links
    .filter((link) => link.source === id || link.target === id)
    .slice(0, limit)
    .map((link) => nameOf(link.source === id ? link.target : link.source));
}
