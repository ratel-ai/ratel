import { BookOpen, ChevronsDownUp, ChevronsUpDown, Ellipsis, Search, Wrench } from "lucide-react";
import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import { flowEdgeCount, flowNodeAriaLabel } from "@/components/console/health/flow-copy";
import type { FlowTint } from "@/lib/readings/trace-signals/view";
import {
  FLOW_LABEL_FONT,
  type FlowLayout,
  type FlowLayoutEdge,
  type FlowLayoutNode,
  type FlowPortBar,
} from "@/lib/views/health/flow-layout";

/**
 * The flow map's marks: column headers, ribbons, rows and the counts a lit
 * ribbon carries. Stateless; `ToolFlowCanvas` decides what is lit.
 */

export const TINT_COLOR: Record<FlowTint, string> = {
  magnet: "var(--color-coral)",
  buried: "var(--color-ctx-tools)",
  dead: "var(--color-warm-muted)",
  healthy: "var(--color-green)",
  none: "var(--color-cream-dim)",
};

/** Ring opacity per tint: dead is `warm-muted/35`, none `cream-dim/60`. */
const RING_OPACITY: Record<FlowTint, number> = {
  magnet: 0.95,
  buried: 0.95,
  dead: 0.35,
  healthy: 0.85,
  none: 0.6,
};

/** A faint wash inside the plate so the tinted tools read at a glance. */
const WASH_OPACITY: Record<FlowTint, number> = {
  magnet: 0.16,
  buried: 0.14,
  dead: 0,
  healthy: 0.12,
  none: 0,
};

/** Start the draw-in once the card itself (420 ms delay) has mostly risen. */
const DRAW_START_MS = 560;
const DRAW_STEP_MS = 260;

export type MarkState = "rest" | "active" | "lit" | "dim";

type Delay = CSSProperties & { "--flow-delay"?: string };

function delay(ms: number): Delay {
  return { "--flow-delay": `${Math.round(ms)}ms` };
}

export function Columns({ layout }: { layout: FlowLayout }) {
  return (
    <g aria-hidden>
      {layout.columns.map((column) => (
        <g key={column.role}>
          {column.index % 2 === 1 && (
            <rect
              x={column.x - 12}
              y={30}
              width={column.width + 24}
              height={layout.height - 36}
              rx={10}
              fill="var(--color-forest-300)"
              fillOpacity={0.1}
            />
          )}
          <text
            x={column.x}
            y={20}
            fill="var(--color-warm-muted)"
            fontSize={10}
            letterSpacing="0.1em"
            className="font-mono uppercase"
          >
            {column.title}
          </text>
        </g>
      ))}
    </g>
  );
}

export interface RibbonProps {
  edge: FlowLayoutEdge;
  title: string;
  state: MarkState;
  /** Draw in on first paint; off once the reader has unfolded the map. */
  animate: boolean;
}

/** One ribbon. A minor one is in the DOM but invisible until one of its ends is in focus. */
export function Ribbon({ edge, title, state, animate }: RibbonProps) {
  const color = TINT_COLOR[edge.tint];
  const sibling = edge.kind === "sibling";
  const hidden = edge.minor && state !== "lit";
  const opacity = hidden
    ? 0
    : state === "lit"
      ? Math.max(0.85, edge.opacity)
      : state === "dim"
        ? 0.06
        : edge.opacity;
  return (
    <g
      data-flow-edge={edge.key}
      data-flow-tint={edge.tint}
      data-flow-minor={edge.minor ? "true" : undefined}
      className="flow-dim"
      style={{ opacity: hidden ? 0 : 1, pointerEvents: hidden ? "none" : undefined }}
    >
      <title>{title}</title>
      <path
        d={edge.path}
        // A unit length lets the draw-in dash cover any path; a dashed bracket keeps real units.
        pathLength={sibling ? undefined : 1}
        fill="none"
        stroke={color}
        strokeOpacity={opacity}
        strokeWidth={edge.width}
        strokeDasharray={sibling ? "3 3" : undefined}
        strokeLinecap="butt"
        className={`flow-dim ${animate && !edge.minor ? (sibling ? "flow-fade" : "flow-draw") : ""}`}
        style={delay(DRAW_START_MS + edge.step * DRAW_STEP_MS)}
      />
    </g>
  );
}

/**
 * The count a lit ribbon carries, set at the end away from the tool in focus
 * (each of those ends is a different row, so the labels never meet), just
 * above the ribbon.
 */
export function RibbonCount({
  edge,
  focusKeys,
}: {
  edge: FlowLayoutEdge;
  focusKeys: ReadonlySet<string>;
}) {
  if (edge.kind === "sibling") return null;
  const atEnd = focusKeys.has(edge.from) || !focusKeys.has(edge.to);
  const point = atEnd ? edge.end : edge.start;
  const x = atEnd ? point.x - 6 : point.x + 6;
  const y = point.y - edge.width / 2 - 3;
  return (
    <text
      aria-hidden
      data-flow-count={edge.key}
      x={x}
      y={y}
      textAnchor={atEnd ? "end" : "start"}
      fill="var(--color-cream)"
      fontSize={10}
      stroke="var(--color-canvas)"
      strokeWidth={3.5}
      strokeOpacity={0.95}
      strokeLinejoin="round"
      paintOrder="stroke"
      className="font-mono"
    >
      {flowEdgeCount(edge)}
    </text>
  );
}

export interface RowProps {
  node: FlowLayoutNode;
  state: MarkState;
  opens: boolean;
  pinned: boolean;
  expanded?: boolean;
  onEnter: (node: FlowLayoutNode) => void;
  onLeave: () => void;
  onActivate: (node: FlowLayoutNode, viaKeyboard: boolean) => void;
}

function rowHandlers({ node, onEnter, onLeave, onActivate }: RowProps) {
  return {
    onPointerEnter: () => onEnter(node),
    onPointerLeave: onLeave,
    onFocus: () => onEnter(node),
    onBlur: onLeave,
    onClick: (event: MouseEvent<SVGGElement>) => {
      event.stopPropagation();
      onActivate(node, false);
    },
    onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onActivate(node, true);
      }
    },
  };
}

function textColor(node: FlowLayoutNode, state: MarkState): string {
  if (state === "active" || state === "lit") return "var(--color-cream)";
  if (node.tint === "dead" || node.kind === "more" || node.kind === "quiet")
    return "var(--color-warm-muted)";
  if (node.tint === "magnet" || node.tint === "buried") return "var(--color-cream)";
  return "var(--color-cream-dim)";
}

function Label({ node, state }: { node: FlowLayoutNode; state: MarkState }) {
  return (
    <text
      aria-hidden
      x={node.labelX - node.x}
      y={FLOW_LABEL_FONT * 0.36}
      fill={textColor(node, state)}
      fontSize={FLOW_LABEL_FONT}
      // A halo in the canvas colour keeps a label crisp where a dimmed ribbon passes.
      stroke="var(--color-canvas)"
      strokeWidth={4}
      strokeOpacity={0.92}
      strokeLinejoin="round"
      paintOrder="stroke"
      className="font-mono"
    >
      {node.text}
    </text>
  );
}

/** The outlet or inlet bar: where a tool's ribbons gather, tinted like the tool. */
function PortBars({ node, state }: { node: FlowLayoutNode; state: MarkState }) {
  const color = TINT_COLOR[node.tint];
  const lit = state === "active" || state === "lit";
  const opacity = (bar: FlowPortBar) => (lit ? 0.9 : bar.quiet ? 0.1 : 0.5);
  return (
    <g aria-hidden transform={`translate(${-node.x} ${-node.y})`}>
      {node.outlet && (
        <>
          <line
            x1={node.labelEnd + 5}
            x2={node.outlet.x - 3}
            y1={node.y}
            y2={node.y}
            stroke="var(--color-cream-dim)"
            strokeOpacity={lit ? 0.5 : node.outlet.quiet ? 0.06 : 0.16}
            strokeDasharray="1 3"
          />
          <rect
            x={node.outlet.x}
            y={node.outlet.top}
            width={3}
            height={Math.max(2, node.outlet.bottom - node.outlet.top)}
            rx={1}
            fill={color}
            fillOpacity={opacity(node.outlet)}
          />
        </>
      )}
      {node.inlet && (
        <rect
          x={node.inlet.x}
          y={node.inlet.top}
          width={3}
          height={Math.max(2, node.inlet.bottom - node.inlet.top)}
          rx={1}
          fill={color}
          fillOpacity={opacity(node.inlet)}
        />
      )}
    </g>
  );
}

/** A tool, skill or the quiet plate: a tinted plate, its label, its port bars. */
export function Row(props: RowProps) {
  const { node, state, opens, pinned } = props;
  const lit = state === "active" || state === "lit";
  const band = Math.max(node.r, 10) + 3;
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={flowNodeAriaLabel(node)}
      aria-pressed={pinned}
      data-flow-node={node.id}
      data-flow-row={node.key}
      data-flow-tint={node.tint}
      data-flow-kind={node.kind}
      data-flow-opens={opens ? "true" : "false"}
      transform={`translate(${node.x} ${node.y})`}
      style={{ opacity: state === "dim" ? 0.28 : 1 }}
      className="flow-dim cursor-pointer outline-none"
      {...rowHandlers(props)}
    >
      <rect
        x={-node.r - 6}
        y={-band}
        width={node.labelEnd - node.x + node.r + 12}
        height={2 * band}
        rx={6}
        fill="var(--color-cream)"
        fillOpacity={state === "active" ? 0.07 : lit ? 0.035 : 0}
        className="flow-dim"
      />
      <PortBars node={node} state={state} />
      <PlateDisc node={node} state={state} />
      {opens && (
        <circle
          aria-hidden
          cx={node.r * 0.74}
          cy={-node.r * 0.74}
          r={2.4}
          fill="var(--color-cream)"
          stroke="var(--color-forest-600)"
          strokeWidth={1.5}
        />
      )}
      <Label node={node} state={state} />
      <FocusRing r={node.r} />
    </g>
  );
}

function FocusRing({ r }: { r: number }) {
  return (
    <circle
      aria-hidden
      r={r + 4}
      fill="none"
      stroke="var(--color-coral)"
      strokeWidth={2}
      className="opacity-0 [g:focus-visible>&]:opacity-100"
    />
  );
}

function PlateDisc({ node, state }: { node: FlowLayoutNode; state: MarkState }) {
  const color = TINT_COLOR[node.tint];
  const ring = state === "active" ? 1 : RING_OPACITY[node.tint];
  const size = Math.max(9, node.r * 1.1);
  const Icon = node.kind === "quiet" ? Ellipsis : node.kind === "skill" ? BookOpen : Wrench;
  return (
    <g aria-hidden>
      {node.kind === "quiet" && (
        <circle
          r={node.r}
          cx={3}
          cy={-3}
          fill="var(--color-forest-600)"
          stroke={color}
          strokeOpacity={0.3}
        />
      )}
      <circle r={node.r} fill="var(--color-forest-600)" />
      {WASH_OPACITY[node.tint] > 0 && (
        <circle r={node.r} fill={color} fillOpacity={WASH_OPACITY[node.tint]} />
      )}
      <circle
        r={node.r}
        fill="none"
        stroke={color}
        strokeOpacity={ring}
        strokeWidth={state === "active" ? 2 : 1.25}
        strokeDasharray={node.tint === "dead" ? "3 3" : undefined}
      />
      <Icon
        x={-size / 2}
        y={-size / 2}
        width={size}
        height={size}
        color={color}
        strokeWidth={2}
        opacity={node.tint === "dead" ? 0.55 : node.tint === "none" ? 0.75 : 1}
      />
    </g>
  );
}

/** Search: a tall bar every pick leaves from, level with the tool it leads to. */
export function SearchBar(props: RowProps) {
  const { node, state, opens, pinned } = props;
  const top = -node.h / 2;
  const lit = state === "active" || state === "lit";
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={flowNodeAriaLabel(node)}
      aria-pressed={pinned}
      data-flow-node={node.id}
      data-flow-row={node.key}
      data-flow-tint={node.tint}
      data-flow-kind={node.kind}
      data-flow-opens={opens ? "true" : "false"}
      transform={`translate(${node.x} ${node.y})`}
      style={{ opacity: state === "dim" ? 0.4 : 1 }}
      className="flow-dim cursor-pointer outline-none"
      {...rowHandlers(props)}
    >
      <rect
        x={-node.r}
        y={top}
        width={2 * node.r}
        height={node.h}
        rx={node.r}
        fill="var(--color-forest-600)"
      />
      <rect
        x={-node.r}
        y={top}
        width={2 * node.r}
        height={node.h}
        rx={node.r}
        fill="var(--color-cream)"
        fillOpacity={lit ? 0.1 : 0.04}
        stroke="var(--color-cream)"
        strokeOpacity={state === "active" ? 0.95 : 0.55}
        strokeWidth={state === "active" ? 2 : 1.25}
        className="flow-dim"
      />
      <Search
        aria-hidden
        x={-6}
        y={top + 5}
        width={12}
        height={12}
        color="var(--color-cream)"
        strokeWidth={2.2}
      />
      <rect
        aria-hidden
        x={-node.r - 4}
        y={top - 4}
        width={2 * node.r + 8}
        height={node.h + 8}
        rx={node.r + 4}
        fill="none"
        stroke="var(--color-coral)"
        strokeWidth={2}
        className="opacity-0 [g:focus-visible>&]:opacity-100"
      />
    </g>
  );
}

/** "+N more" folds a long column; unfolded, the same row reads "Show fewer". */
export function MoreRow(props: RowProps) {
  const { node, state } = props;
  const Icon = props.expanded ? ChevronsDownUp : ChevronsUpDown;
  const lit = state === "active" || state === "lit";
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={flowNodeAriaLabel(node)}
      aria-expanded={props.expanded}
      data-flow-node={node.id}
      data-flow-row={node.key}
      data-flow-tint={node.tint}
      data-flow-kind={node.kind}
      data-flow-more={node.moreCount ?? 0}
      transform={`translate(${node.x} ${node.y})`}
      style={{ opacity: state === "dim" ? 0.4 : 1 }}
      className="flow-dim cursor-pointer outline-none"
      {...rowHandlers(props)}
    >
      <rect
        x={-node.r - 5}
        y={-node.r - 3}
        width={node.labelEnd - node.x + node.r + 12}
        height={2 * node.r + 6}
        rx={node.r + 3}
        fill="var(--color-cream)"
        fillOpacity={lit ? 0.08 : 0.03}
        stroke="var(--color-cream-dim)"
        strokeOpacity={lit ? 0.5 : 0.22}
        strokeDasharray="2 3"
        className="flow-dim"
      />
      <Icon
        aria-hidden
        x={-6}
        y={-6}
        width={12}
        height={12}
        color="var(--color-cream-dim)"
        strokeWidth={2}
      />
      <Label node={node} state={state} />
      <FocusRing r={node.r} />
    </g>
  );
}
