"use client";

import { cn } from "@ratel/design-system/cn";
import type { FocusEvent, PointerEvent } from "react";
import type { NodeState } from "@/components/console/intent-map/MapMarks";
import type { Circle } from "@/lib/views/intents/map/map-geometry";
import {
  type GroupColor,
  type NetworkLink,
  type NetworkNode,
  networkNodeName,
} from "@/lib/views/intents/map/tool-network";
import type { LinkShape } from "@/lib/views/intents/map/tool-network-layout";

/** How a link is drawn: at rest, lit with a tool or by the pointer, or dimmed behind them. */
export type LinkTone = "rest" | "lit" | "dim";

// Written out whole so the class names exist at build time.
const FILL: Record<GroupColor, string> = {
  "chart-1": "fill-chart-1",
  "chart-5": "fill-chart-5",
  "chart-4": "fill-chart-4",
};
const STROKE: Record<GroupColor, string> = {
  "chart-1": "stroke-chart-1",
  "chart-5": "stroke-chart-5",
  "chart-4": "stroke-chart-4",
};
const TINT: Record<GroupColor, string> = {
  "chart-1": "fill-chart-1/10",
  "chart-5": "fill-chart-5/10",
  "chart-4": "fill-chart-4/10",
};
const TINT_LIT: Record<GroupColor, string> = {
  "chart-1": "fill-chart-1/15",
  "chart-5": "fill-chart-5/15",
  "chart-4": "fill-chart-4/15",
};

/** How a home's hull is drawn: in a task's color, neutral (a task past the colored three), or Shared. */
export type HullTone = GroupColor | "neutral" | "shared";

/**
 * A home's soft hull, behind its tools: the canvas color first (the dot grid
 * stops at its edge, as at a blob's on the map), then a faint tint and a
 * quiet outline: a task's color, neutral gray for a task past the colored
 * three, and a dashed outline for Shared (tools many tasks run).
 */
export function NetworkHull({
  id,
  path,
  color,
  state,
}: {
  id: string;
  path: string;
  color: HullTone;
  state: "rest" | "lit" | "dim";
}) {
  const tinted = color !== "neutral" && color !== "shared";
  return (
    <g
      data-hull={id}
      data-tone={color}
      className={cn(
        "transition-opacity duration-120 motion-reduce:transition-none",
        state === "dim" && "opacity-40",
      )}
    >
      <path d={path} className="fill-app" />
      <path
        d={path}
        vectorEffect="non-scaling-stroke"
        className={cn(
          "[stroke-width:1px]",
          tinted
            ? cn(
                "[stroke-opacity:0.45]",
                state === "lit" ? TINT_LIT[color] : TINT[color],
                STROKE[color],
              )
            : cn(
                state === "lit" ? "fill-fg/[0.07]" : "fill-fg/[0.035]",
                color === "shared"
                  ? "stroke-fg-faint [stroke-dasharray:4_3]"
                  : "stroke-line-strong",
              ),
        )}
      />
    </g>
  );
}

/**
 * The globe: one disc that holds every home, faintly lifted off the dot grid,
 * and, when some tools belong to no task, the dashed ring they sit on.
 */
export function NetworkGlobe({ disc, ring }: { disc: Circle; ring: Circle | null }) {
  return (
    <g aria-hidden data-globe="" className="pointer-events-none">
      <circle cx={disc.x} cy={disc.y} r={disc.r} className="fill-app" />
      <circle
        cx={disc.x}
        cy={disc.y}
        r={disc.r}
        vectorEffect="non-scaling-stroke"
        className="fill-fg/[0.015] stroke-line [stroke-width:1px]"
      />
      {ring ? (
        <circle
          data-ring=""
          cx={ring.x}
          cy={ring.y}
          r={ring.r}
          vectorEffect="non-scaling-stroke"
          className="fill-none stroke-line-strong [stroke-dasharray:3_5] [stroke-width:1px]"
        />
      ) : null}
    </g>
  );
}

/**
 * A home's name on screen, like a pin: a task's color square (gray past the
 * colored three) and its name, or the Shared and Other marks with theirs.
 * Text only: a task's name is model-written, so it never goes in an attribute.
 */
export function HomeLabel({
  kind,
  color,
  text,
  x,
  y,
  state,
}: {
  kind: "task" | "group" | "shared" | "other";
  color: GroupColor | null;
  text: string;
  /** The middle of the label's left edge, on screen. */
  x: number;
  y: number;
  state: "rest" | "lit" | "dim";
}) {
  return (
    <g
      data-home-label={kind}
      className={cn(
        "transition-opacity duration-120 motion-reduce:transition-none",
        state === "dim" && "opacity-40",
      )}
    >
      {kind === "shared" ? (
        <g>
          <circle
            cx={x + 5}
            cy={y}
            r={4.75}
            className="fill-none stroke-fg-faint [stroke-width:1px] [stroke-dasharray:2_1.5]"
          />
          <circle cx={x + 5} cy={y} r={2.25} className="fill-fg-subtle" />
        </g>
      ) : kind === "other" ? (
        <circle
          cx={x + 5}
          cy={y}
          r={4.25}
          className="fill-none stroke-fg-subtle [stroke-dasharray:2_2] [stroke-width:1px]"
        />
      ) : (
        <rect
          x={x + 1}
          y={y - 4}
          width={8}
          height={8}
          rx={2}
          className={color ? FILL[color] : "fill-fg-subtle"}
        />
      )}
      <text
        x={x + 15}
        y={y}
        dominantBaseline="central"
        className={cn(
          "text-xs font-medium [paint-order:stroke] stroke-app [stroke-linejoin:round] [stroke-width:3px]",
          state === "lit" ? "fill-fg" : "fill-fg-muted",
        )}
      >
        {text}
      </text>
    </g>
  );
}

/**
 * A link: a gentle curve, thicker and brighter the surer it is, in its
 * group's hue when both tools share one; with an order, a small arrowhead at
 * the tool that runs second. A wider, invisible stroke takes the pointer.
 */
export function NetworkLinkMark({
  link,
  shape,
  color,
  tone,
  onHover,
}: {
  link: NetworkLink;
  shape: LinkShape;
  /** The hue of the group both tools are in, if it has one. */
  color: GroupColor | null;
  tone: LinkTone;
  onHover: (id: string | null) => void;
}) {
  const width = 1 + 1.5 * link.strength;
  const opacity =
    tone === "lit" ? 0.85 : tone === "dim" ? 0.08 : color ? 0.6 : 0.35 + 0.4 * link.strength;
  const paint = tone === "lit" ? "stroke-fg" : color ? STROKE[color] : "stroke-fg-faint";
  const fill = tone === "lit" ? "fill-fg" : color ? FILL[color] : "fill-fg-faint";
  return (
    <g data-link={link.id} data-directed={link.directed || undefined} data-tone={tone}>
      <path
        d={shape.d}
        vectorEffect="non-scaling-stroke"
        className={cn(
          "fill-none transition-[stroke-opacity] duration-120 motion-reduce:transition-none",
          paint,
        )}
        style={{
          strokeWidth: tone === "lit" ? width + 0.5 : width,
          strokeOpacity: opacity,
          strokeLinecap: "round",
        }}
      />
      {shape.arrow ? (
        <path
          d={shape.arrow}
          className={fill}
          style={{ fillOpacity: Math.min(1, opacity + 0.15) }}
        />
      ) : null}
      {tone === "dim" ? null : (
        <path
          d={shape.d}
          vectorEffect="non-scaling-stroke"
          className="cursor-help fill-none stroke-transparent [stroke-width:12px]"
          onPointerEnter={() => onHover(link.id)}
          onPointerLeave={() => onHover(null)}
        />
      )}
    </g>
  );
}

type NodeHandlers = {
  onHover: (id: string | null) => void;
  onFocus: (event: FocusEvent<SVGGElement>, id: string) => void;
  onBlur: () => void;
  onPointerDown: (event: PointerEvent<SVGGElement>, id: string) => void;
  onPointerMove: (event: PointerEvent<SVGGElement>) => void;
  onPointerUp: (event: PointerEvent<SVGGElement>) => void;
  onClick: (id: string) => void;
};

/**
 * A tool (a dot) or a skill (a rounded square), sized by calls and filled
 * with its task's color. A tool many tasks share wears a ring; a tool linked
 * to nothing is quieter; a tool the catalog no longer lists is dashed. Named
 * by its id and numbers, never by an intent or a task.
 */
export function NetworkNodeMark({
  node,
  mark,
  color,
  home = null,
  state,
  tabIndex,
  onHover,
  onFocus,
  onBlur,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onClick,
}: {
  node: NetworkNode;
  mark: Circle;
  color: GroupColor | null;
  /** Where it lives: a ring marks a tool many tasks share; without homes, a hub. */
  home?: "task" | "group" | "shared" | "other" | null;
  state: NodeState;
  tabIndex: number;
} & NodeHandlers) {
  const ring = state === "selected" || state === "focused";
  const lit = ring || state === "lit";
  // A 2 px ring in the canvas color keeps a mark clear of the links under it.
  // A tool linked to nothing is quieter than the linked ones: the links are the story.
  const paint = node.missing
    ? cn("fill-app [stroke-dasharray:2_2]", color ? STROKE[color] : "stroke-fg-subtle")
    : cn(
        "stroke-app",
        color
          ? FILL[color]
          : lit
            ? "fill-fg"
            : node.partners === 0
              ? "fill-fg-faint"
              : "fill-fg-subtle",
      );
  const { x, y, r } = mark;
  const ringed = home === null ? node.hub : home === "shared";
  const halo = ringed ? r + 3.5 : r;
  return (
    <g
      data-node={node.id}
      data-kind={node.kind}
      data-state={state}
      data-group={node.group ?? undefined}
      data-hub={ringed || undefined}
      data-home={home ?? undefined}
      data-missing={node.missing || undefined}
      role="button"
      tabIndex={tabIndex}
      aria-label={networkNodeName(node, home)}
      aria-pressed={state === "selected"}
      // The coral ring around the mark is the focus ring; no box around it.
      className={cn(
        "cursor-pointer touch-none outline-none focus-visible:outline-none transition-opacity duration-120 motion-reduce:transition-none",
        state === "dim" && "opacity-30",
      )}
      onPointerEnter={() => onHover(node.id)}
      onPointerLeave={() => onHover(null)}
      onPointerDown={(event) => onPointerDown(event, node.id)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={(event) => {
        event.stopPropagation();
        onClick(node.id);
      }}
      onFocus={(event) => onFocus(event, node.id)}
      onBlur={onBlur}
    >
      {/* A 24 px hit area, larger than the mark. */}
      <circle cx={x} cy={y} r={Math.max(halo + 4, 12)} className="fill-transparent" />
      {ringed ? (
        <circle
          cx={x}
          cy={y}
          r={r + 3.5}
          vectorEffect="non-scaling-stroke"
          className={cn(
            "fill-none [stroke-width:1.5px]",
            lit ? "stroke-fg-muted" : "stroke-fg-faint",
          )}
        />
      ) : null}
      {ring ? (
        <circle
          cx={x}
          cy={y}
          r={halo + 4}
          vectorEffect="non-scaling-stroke"
          className={cn(
            "fill-none stroke-accent-mark",
            state === "focused" ? "[stroke-width:2px]" : "[stroke-width:1.5px]",
          )}
        />
      ) : null}
      {node.kind === "skill" ? (
        <rect
          x={x - r}
          y={y - r}
          width={r * 2}
          height={r * 2}
          rx={Math.max(1.5, r * 0.35)}
          vectorEffect="non-scaling-stroke"
          className={cn(
            "[stroke-width:2px] transition-[fill] duration-120 motion-reduce:transition-none",
            paint,
          )}
        />
      ) : (
        <circle
          cx={x}
          cy={y}
          r={r}
          vectorEffect="non-scaling-stroke"
          className={cn(
            "[stroke-width:2px] transition-[fill] duration-120 motion-reduce:transition-none",
            paint,
          )}
        />
      )}
    </g>
  );
}
