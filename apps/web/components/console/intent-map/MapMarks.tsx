"use client";

import { cn } from "@ratel/design-system/cn";
import type { FocusEvent } from "react";
import type { Circle } from "@/lib/views/intents/map/map-geometry";
import type { ToolMark } from "@/lib/views/intents/map/map-marks";
import type { LayoutNode } from "@/lib/views/intents/map/map-membership";
import {
  askGroupName,
  type MapAsk,
  type MapCapability,
  type MapTint,
} from "@/lib/views/intents/map/map-model";
import { linkShape } from "@/lib/views/intents/map/tool-network-layout";

/** How a mark is drawn: at rest, lit with a neighbour, dimmed behind one, selected, or focused by keyboard. */
export type NodeState = "rest" | "lit" | "dim" | "selected" | "focused";

type MarkHandlers = {
  onHover: (id: string | null) => void;
  onOpen: (id: string) => void;
  onFocus: (event: FocusEvent<SVGGElement>, id: string) => void;
  onBlur: () => void;
};

/** On screen, the radius of a warning badge's disc. */
export const BADGE_RADIUS = 9;

// A task's color, written out whole so the class names exist at build time.
const TINT_REST: Record<MapTint, string> = {
  "chart-1": "fill-chart-1/[0.08]",
  "chart-5": "fill-chart-5/[0.08]",
  "chart-4": "fill-chart-4/[0.08]",
};
const TINT_LIT: Record<MapTint, string> = {
  "chart-1": "fill-chart-1/[0.15]",
  "chart-5": "fill-chart-5/[0.15]",
  "chart-4": "fill-chart-4/[0.15]",
};
const TINT_SOLID: Record<MapTint, string> = {
  "chart-1": "fill-chart-1",
  "chart-5": "fill-chart-5",
  "chart-4": "fill-chart-4",
};

/** A warning triangle on a small disc of the canvas color, pinned to an outline. */
export function WarningBadge({ x, y }: { x: number; y: number }) {
  return (
    <g data-badge="warning">
      <circle
        cx={x}
        cy={y}
        r={BADGE_RADIUS}
        className="fill-app stroke-warning [stroke-width:1px]"
      />
      <path
        d={`M${x},${y - 4.5}L${x + 4.5},${y + 3.5}L${x - 4.5},${y + 3.5}Z`}
        className="fill-warning"
      />
    </g>
  );
}

/**
 * Under every blob, the canvas color: the dot grid stops at a blob's edge,
 * and blobs that overlap still layer their tints, so an overlap reads lighter.
 */
export function GroupBase({ path }: { path: string }) {
  return <path d={path} className="fill-app" />;
}

/**
 * An intent: its blob's tint, the part that takes the pointer and focus. An
 * intent whose main task is one of the three busiest wears that task's color,
 * faintly. Named by its id, never its label (it comes from people's asks).
 */
export function Group({
  ask,
  path,
  state,
  tabIndex,
  tools,
  onHover,
  onOpen,
  onFocus,
  onBlur,
}: {
  ask: MapAsk;
  path: string;
  state: NodeState;
  tabIndex: number;
  tools: number;
} & MarkHandlers) {
  return (
    <g
      data-node={ask.id}
      data-kind="ask"
      data-state={state}
      data-problem={ask.problem !== null || undefined}
      role="button"
      tabIndex={tabIndex}
      aria-label={askGroupName(ask, tools)}
      aria-pressed={state === "selected"}
      // The blob's own coral outline is the focus ring; no box around it.
      className={cn(
        "cursor-pointer outline-none focus-visible:outline-none transition-opacity duration-120 motion-reduce:transition-none",
        state === "dim" && "opacity-40",
      )}
      onPointerEnter={() => onHover(ask.id)}
      onPointerLeave={() => onHover(null)}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(ask.id);
      }}
      onFocus={(event) => onFocus(event, ask.id)}
      onBlur={onBlur}
    >
      <path
        d={path}
        className={cn(
          "transition-[fill] duration-120 motion-reduce:transition-none",
          state === "selected"
            ? "fill-accent-subtle"
            : state === "lit" || state === "focused"
              ? ask.tint
                ? TINT_LIT[ask.tint]
                : "fill-fg/[0.085]"
              : ask.tint
                ? TINT_REST[ask.tint]
                : "fill-fg/[0.045]",
        )}
      />
    </g>
  );
}

/**
 * A blob's outline, drawn above every tint so overlapping blobs keep both
 * edges: coral when it is selected or focused, brighter when it is lit. A
 * problem is the warning badge's to show, never an amber outline: yellow is a
 * task's color.
 */
export function GroupOutline({ path, state }: { path: string; state: NodeState }) {
  return (
    <path
      d={path}
      vectorEffect="non-scaling-stroke"
      className={cn(
        "fill-none transition-[stroke,opacity] duration-120 motion-reduce:transition-none",
        state === "selected"
          ? "stroke-accent-mark [stroke-width:1.5px]"
          : state === "focused"
            ? "stroke-accent-mark [stroke-width:2px]"
            : cn(state === "lit" ? "stroke-fg-faint" : "stroke-line-strong", "[stroke-width:1px]"),
        state === "dim" && "opacity-40",
      )}
    />
  );
}

/** A group's name, set inside its blob in map units, so it shrinks and grows with the drawing. */
export function GroupName({
  x,
  y,
  lines,
  fontSize,
  lineHeight,
  state,
}: {
  x: number;
  y: number;
  lines: readonly string[];
  fontSize: number;
  lineHeight: number;
  state: NodeState;
}) {
  const top = y - ((lines.length - 1) * lineHeight) / 2;
  return (
    <text
      x={x}
      y={top}
      fontSize={fontSize}
      textAnchor="middle"
      dominantBaseline="central"
      className={cn(
        "font-medium transition-[fill] duration-120 motion-reduce:transition-none",
        state === "rest" ? "fill-fg-muted" : state === "dim" ? "fill-fg-subtle" : "fill-fg",
      )}
    >
      {lines.map((line, index) => (
        <tspan key={index} x={x} y={top + index * lineHeight}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

/**
 * One of a tool's marks inside one intent: a dot (a skill is a rounded square)
 * sized by the calls from that intent's asks, in its main task's color, dashed
 * when the catalog no longer has it. A tool other intents use too wears a thin
 * ring: it has a mark in each of them. Named by ids and numbers, never by an
 * intent's name.
 */
export function Mark({
  capability,
  mark,
  node,
  state,
  tabIndex,
  onHover,
  onOpen,
  onFocus,
  onBlur,
}: {
  capability: MapCapability;
  mark: ToolMark;
  node: LayoutNode;
  state: NodeState;
  tabIndex: number;
} & MarkHandlers) {
  const ring = state === "selected" || state === "focused";
  // A 2 px ring in the canvas color keeps a mark clear of the tint and outlines around it.
  const fill = capability.missing
    ? "fill-app stroke-fg-subtle [stroke-dasharray:2_2]"
    : capability.tint
      ? cn(TINT_SOLID[capability.tint], "stroke-app")
      : ring || state === "lit"
        ? "fill-fg stroke-app"
        : "fill-fg-subtle stroke-app";
  const calls = `${mark.weight.toLocaleString("en-US")} ${mark.weight === 1 ? "call" : "calls"}`;
  return (
    <g
      data-node={mark.id}
      data-tool={capability.id}
      data-kind={capability.kind}
      data-state={state}
      data-shared={mark.shared || undefined}
      data-missing={capability.missing || undefined}
      role="button"
      tabIndex={tabIndex}
      aria-label={`${capability.name}, ${capability.kind}: ${calls} in intent ${mark.ask}${mark.shared ? `, shared by ${capability.asks} intents` : ""}${capability.missing ? ", not in your catalog" : ""}`}
      aria-pressed={state === "selected"}
      // The coral ring around the mark is the focus ring; no box around it.
      className={cn(
        "cursor-pointer outline-none focus-visible:outline-none transition-opacity duration-120 motion-reduce:transition-none",
        state === "dim" && "opacity-35",
      )}
      onPointerEnter={() => onHover(mark.id)}
      onPointerLeave={() => onHover(null)}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(capability.id);
      }}
      onFocus={(event) => onFocus(event, mark.id)}
      onBlur={onBlur}
    >
      {/* A 24 px hit area, larger than the mark. */}
      <circle cx={node.x} cy={node.y} r={Math.max(node.r + 4, 12)} className="fill-transparent" />
      {mark.shared ? (
        <circle
          data-shared-ring=""
          cx={node.x}
          cy={node.y}
          r={node.r + SHARED_RING}
          vectorEffect="non-scaling-stroke"
          className={cn(
            "fill-none [stroke-width:1px]",
            state === "lit" || ring ? "stroke-fg-muted" : "stroke-fg-faint",
          )}
        />
      ) : null}
      {ring ? (
        <circle
          cx={node.x}
          cy={node.y}
          r={node.r + SHARED_RING + 2.5}
          vectorEffect="non-scaling-stroke"
          className="fill-none stroke-accent-mark [stroke-width:1.5px]"
        />
      ) : null}
      {capability.kind === "skill" ? (
        <rect
          x={node.x - node.r}
          y={node.y - node.r}
          width={node.r * 2}
          height={node.r * 2}
          rx={Math.max(1.5, node.r * 0.35)}
          vectorEffect="non-scaling-stroke"
          className={cn(
            "[stroke-width:2px] transition-[fill] duration-120 motion-reduce:transition-none",
            fill,
          )}
        />
      ) : (
        <circle
          cx={node.x}
          cy={node.y}
          r={node.r}
          vectorEffect="non-scaling-stroke"
          className={cn(
            "[stroke-width:2px] transition-[fill] duration-120 motion-reduce:transition-none",
            fill,
          )}
        />
      )}
    </g>
  );
}

/** How far a shared tool's ring sits outside its mark (map units). */
export const SHARED_RING = 2.75;

const LINE_STROKE: Record<MapTint, string> = {
  "chart-1": "stroke-chart-1",
  "chart-5": "stroke-chart-5",
  "chart-4": "stroke-chart-4",
};
const LINE_FILL: Record<MapTint, string> = {
  "chart-1": "fill-chart-1",
  "chart-5": "fill-chart-5",
  "chart-4": "fill-chart-4",
};

/**
 * From the mark being pointed at to each of the tool's other marks: a gentle
 * curve ending in a small arrowhead at the intent it also serves, in the
 * tool's task color. Drawn only while the tool is lit; never takes the pointer.
 */
export function ToolLines({
  from,
  to,
  tint,
}: {
  from: Circle;
  to: readonly Circle[];
  tint: MapTint | null | undefined;
}) {
  return (
    <g data-tool-lines="" aria-hidden className="pointer-events-none">
      {to.map((target, index) => {
        const shape = linkShape(
          { ...from, r: from.r + SHARED_RING },
          { ...target, r: target.r + SHARED_RING },
          true,
        );
        if (!shape) return null;
        return (
          <g key={index}>
            <path
              d={shape.d}
              vectorEffect="non-scaling-stroke"
              className={cn(
                "fill-none [stroke-width:1.25px] [stroke-linecap:round] [stroke-opacity:0.8]",
                tint ? LINE_STROKE[tint] : "stroke-fg-muted",
              )}
            />
            {shape.arrow ? (
              <path
                d={shape.arrow}
                className={cn("[fill-opacity:0.9]", tint ? LINE_FILL[tint] : "fill-fg-muted")}
              />
            ) : null}
          </g>
        );
      })}
    </g>
  );
}
