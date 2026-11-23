"use client";

import {
  type CSSProperties,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { requestSignalOpen } from "@/components/console/health/anchors";
import { flowEdgeTitle, flowFocusCopy } from "@/components/console/health/flow-copy";
import { ToolFlowCard } from "@/components/console/health/ToolFlowCard";
import {
  Columns,
  type MarkState,
  MoreRow,
  Ribbon,
  RibbonCount,
  Row,
  SearchBar,
} from "@/components/console/health/ToolFlowParts";
import type { FlowLayout, FlowLayoutEdge, FlowLayoutNode } from "@/lib/views/health/flow-layout";

export interface ToolFlowCanvasProps {
  /** The folded layout, drawn first. */
  layout: FlowLayout;
  /** The unfolded layout, when some column folds; the "+N more" rows swap to it. */
  expandedLayout?: FlowLayout | null;
  /** Node id to the DOM ids of its signal cards, first one first. */
  anchors: Readonly<Record<string, readonly string[]>>;
}

/**
 * The flow map's drawing and its interaction layer. Everything is placed
 * already, on the server; this only decides what is lit.
 *
 * - Hover (or keyboard focus) previews a tool: its ribbons light, with their
 *   counts, and the rest dims. Both rows of a tool (Picked and Then) light.
 * - A click (Enter or Space) pins the focus and opens a card with the tool's
 *   paths and, when a signal names it, an "Open problem" link to that card.
 *   Pinning first, rather than jumping straight to the card, lets a reader
 *   trace a tool without being carried off the map. Esc, the card's close
 *   button, a click on empty canvas or anywhere outside the map clears it.
 * - A "+N more" row swaps in the unfolded layout; "Show fewer" swaps back.
 *
 * Motion: once the card has risen in, picks and then "ran next" ribbons draw
 * on once with `stroke-dashoffset`. After that nothing moves: focus changes
 * opacity only, and unfolding swaps layouts without drawing again. Under
 * reduced motion the drawing is simply there.
 */

/** On narrow screens the drawing keeps at least this share of its size and scrolls. */
const MIN_SCALE = 0.85;

const STYLES = `
@media (prefers-reduced-motion: no-preference) {
  [data-flow-canvas] .flow-draw {
    stroke-dasharray: 1;
    animation: flow-draw 720ms cubic-bezier(0.22, 1, 0.36, 1) both;
    animation-delay: var(--flow-delay, 0ms);
  }
  [data-flow-canvas] .flow-fade {
    animation: flow-fade 320ms ease-out both;
    animation-delay: var(--flow-delay, 0ms);
  }
  [data-flow-canvas] .flow-dim {
    transition: opacity 160ms ease, fill-opacity 160ms ease, stroke-opacity 160ms ease;
  }
}
@keyframes flow-draw {
  from { stroke-dashoffset: 1; }
  to { stroke-dashoffset: 0; }
}
@keyframes flow-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
`;

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Takes the reader to the node's first signal card that is on the page, by its
 * anchor. A card the plan hides has no anchor, so the locked panel stands in.
 */
function openSignal(ids: readonly string[] | undefined) {
  if (!ids || ids.length === 0) return;
  const behavior: ScrollBehavior = prefersReducedMotion() ? "auto" : "smooth";
  const present = ids.find((id) => document.getElementById(id));
  if (!present) {
    document.querySelector("[data-signals-locked]")?.scrollIntoView({ behavior, block: "center" });
    return;
  }
  if (window.location.hash === `#${present}`) {
    // The same hash fires no event, so ask the list to open it (and close the rest).
    requestSignalOpen(present);
    document.getElementById(present)?.scrollIntoView({ behavior, block: "start" });
    return;
  }
  window.location.hash = present;
}

export interface FlowFocus {
  /** Row keys of the tool in focus (both its rows), and every edge touching them. */
  rows: ReadonlySet<string>;
  edges: ReadonlySet<string>;
  /** Rows at the other end of a lit edge. */
  neighbours: ReadonlySet<string>;
}

/** What lights when the tool `id` is in focus. */
export function flowFocus(layout: FlowLayout, id: string): FlowFocus {
  const rows = new Set(layout.nodes.filter((node) => node.id === id).map((node) => node.key));
  const edges = new Set<string>();
  const neighbours = new Set<string>();
  for (const edge of layout.edges) {
    if (!rows.has(edge.from) && !rows.has(edge.to)) continue;
    edges.add(edge.key);
    neighbours.add(rows.has(edge.from) ? edge.to : edge.from);
  }
  return { rows, edges, neighbours };
}

function rowState(node: FlowLayoutNode, focus: FlowFocus | null): MarkState {
  if (!focus) return "rest";
  if (focus.rows.has(node.key)) return "active";
  return focus.neighbours.has(node.key) ? "lit" : "dim";
}

function edgeState(edge: FlowLayoutEdge, focus: FlowFocus | null): MarkState {
  if (!focus) return "rest";
  return focus.edges.has(edge.key) ? "lit" : "dim";
}

interface Pin {
  id: string;
  /** The row the pin was made from, where the card sits and focus returns. */
  key: string;
}

export function ToolFlowCanvas({
  layout: folded,
  expandedLayout = null,
  anchors,
}: ToolFlowCanvasProps) {
  const [expanded, setExpanded] = useState(false);
  const [unfoldedOnce, setUnfoldedOnce] = useState(false);
  const [hover, setHover] = useState<Pin | null>(null);
  const [pin, setPin] = useState<Pin | null>(null);
  const [focusCard, setFocusCard] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const layout = expanded && expandedLayout ? expandedLayout : folded;

  const labels = useMemo(
    () => new Map(layout.nodes.map((node) => [node.key, node.label])),
    [layout.nodes],
  );
  const byKey = useMemo(
    () => new Map(layout.nodes.map((node) => [node.key, node])),
    [layout.nodes],
  );
  const current = pin ?? hover;
  const focus = useMemo(() => (current ? flowFocus(layout, current.id) : null), [layout, current]);
  const tools = new Set(
    layout.nodes
      .filter((node) => node.kind === "tool" || node.kind === "skill")
      .map((node) => node.id),
  ).size;

  const clearPin = useCallback(
    (restoreFocus: boolean) => {
      setPin(null);
      setFocusCard(false);
      if (restoreFocus && pin) {
        rootRef.current
          ?.querySelector<SVGGElement>(`[data-flow-row="${CSS.escape(pin.key)}"]`)
          ?.focus();
      }
    },
    [pin],
  );

  // While pinned: Esc anywhere clears it, and so does a press outside the map.
  useEffect(() => {
    if (!pin) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearPin(true);
    };
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) clearPin(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [pin, clearPin]);

  // A pin made from the keyboard moves focus into its card, so its link is the next stop.
  useEffect(() => {
    if (pin && focusCard) cardRef.current?.focus();
  }, [pin, focusCard]);

  const onActivate = (node: FlowLayoutNode, viaKeyboard: boolean) => {
    if (node.kind === "more") {
      setExpanded((value) => !value);
      setUnfoldedOnce(true);
      setHover(null);
      return;
    }
    if (pin?.id === node.id) {
      clearPin(false);
      return;
    }
    setPin({ id: node.id, key: node.key });
    setFocusCard(viaKeyboard);
  };
  const onEnter = (node: FlowLayoutNode) => setHover({ id: node.id, key: node.key });
  const onLeave = () => setHover(null);

  const cardNode = current ? byKey.get(current.key) : undefined;
  const cardAnchors = cardNode ? anchors[cardNode.id] : undefined;
  const onOpen = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    openSignal(cardAnchors);
  };
  const litEdges = focus ? layout.edges.filter((edge) => focus.edges.has(edge.key)) : [];

  return (
    <div data-flow-canvas="true" className="mt-4" ref={rootRef}>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <div className="overflow-x-auto overscroll-x-contain rounded-xl bg-base-deep/40">
        {/* Below the mobile breakpoint the drawing keeps a minimum size and
            scrolls sideways; from `sm` up it scales to the card's width. */}
        <div
          className="relative min-w-[var(--flow-min-width)] sm:min-w-0"
          style={
            { "--flow-min-width": `${Math.round(layout.width * MIN_SCALE)}px` } as CSSProperties
          }
        >
          <svg
            role="group"
            aria-label={`Tool flow map: ${tools} tools and ${layout.edges.length} paths`}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            width="100%"
            className="block h-auto select-none"
            data-flow-expanded={layout.expanded ? "true" : "false"}
            onClick={() => pin && clearPin(false)}
          >
            <Columns layout={layout} />
            <g aria-hidden>
              {layout.edges.map((edge) => (
                <Ribbon
                  key={edge.key}
                  edge={edge}
                  title={flowEdgeTitle(edge, labels)}
                  state={edgeState(edge, focus)}
                  animate={!unfoldedOnce}
                />
              ))}
            </g>
            <g>
              {layout.nodes.map((node) => {
                const props = {
                  node,
                  state: rowState(node, focus),
                  opens: (anchors[node.id]?.length ?? 0) > 0,
                  pinned: pin?.id === node.id,
                  expanded: layout.expanded,
                  onEnter,
                  onLeave,
                  onActivate,
                };
                if (node.kind === "search") return <SearchBar key={node.key} {...props} />;
                if (node.kind === "more") return <MoreRow key={node.key} {...props} />;
                return <Row key={node.key} {...props} />;
              })}
            </g>
            {focus && (
              <g aria-hidden>
                {litEdges.map((edge) => (
                  <RibbonCount key={edge.key} edge={edge} focusKeys={focus.rows} />
                ))}
              </g>
            )}
          </svg>
          {cardNode && (
            <ToolFlowCard
              node={cardNode}
              layout={layout}
              copy={flowFocusCopy(cardNode, layout.edges, labels, (cardAnchors?.length ?? 0) > 0)}
              pinned={pin !== null}
              anchor={cardAnchors?.[0] ?? null}
              onOpen={onOpen}
              onClose={() => clearPin(true)}
              cardRef={cardRef}
            />
          )}
        </div>
      </div>
      <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.1em] text-warm-muted sm:hidden">
        Scroll sideways to follow the flow · tap a tool to trace it
      </p>
    </div>
  );
}
