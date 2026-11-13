"use client";

import { cn } from "@ratel/design-system/cn";
import { NounIcon } from "@ratel/design-system/entity";
import { Callout, EmptyState } from "@ratel/design-system/states";
import type { SankeyLink, SankeyNode } from "d3-sankey";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { MapLoader } from "@/components/console/intent-map/MapLoader";
import { middleCut } from "@/components/console/intent-map/network-labels";
import { captureClientException } from "@/lib/platform/track-client";
import {
  buildFlowData,
  type FlowLink,
  type FlowNode,
  flowNodeName,
} from "@/lib/views/intents/map/flow";
import { labelWidth } from "@/lib/views/intents/map/map-geometry";
import { type IntentMapModel, type MapTint, mapLayoutKey } from "@/lib/views/intents/map/map-model";

/**
 * The Flow lens of the same model: the busiest intents on the left, the tools
 * and skills that answered them on the right, the rest folded into one Other
 * row on each side, one ribbon per pair, as wide as its calls. Each row and
 * ribbon wears its task's color (a tool's ribbons the tool's task), and thin
 * ribbons fade, so the bands read and the trickles stay quiet. `d3-sankey`
 * places it (loaded only here, in the browser); the shape of the data is
 * `buildFlowData`'s. Hover a row or a ribbon to trace it; click a row to open
 * it.
 */

type Placed = {
  nodes: Array<SankeyNode<FlowNode, FlowLink>>;
  links: Array<SankeyLink<FlowNode, FlowLink> & { path: string }>;
  height: number;
};

const ROW = 34;
const MIN_HEIGHT = 320;
/** Room above the drawing for the two column headers. */
const HEADER = 28;

// A task's color, written out whole so the class names exist at build time.
const RIBBON: Record<MapTint, string> = {
  "chart-1": "stroke-chart-1",
  "chart-5": "stroke-chart-5",
  "chart-4": "stroke-chart-4",
};
const BAR: Record<MapTint, string> = {
  "chart-1": "fill-chart-1",
  "chart-5": "fill-chart-5",
  "chart-4": "fill-chart-4",
};

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A ribbon's opacity at rest: a wide one reads, a trickle stays quiet. */
export function ribbonOpacity(width: number, tinted: boolean): number {
  const weight = Math.min(1, Math.max(0, width) / 14);
  return (tinted ? 0.22 : 0.14) + (tinted ? 0.3 : 0.2) * weight;
}

export function IntentFlow({
  model,
  selectedId,
  onOpen,
  className,
}: {
  model: IntentMapModel;
  selectedId: string | null;
  onOpen: (id: string) => void;
  className?: string;
}) {
  const pathname = usePathname();
  const data = useMemo(() => buildFlowData(model), [model]);
  // Laid out again only when what it draws changes (ids, volumes, links), never
  // for a new copy of the same model; until a new layout is ready the last one stays.
  const layoutKey = useMemo(() => mapLayoutKey(model), [model]);
  const dataRef = useRef(data);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [placed, setPlaced] = useState<{ key: string; width: number; layout: Placed } | null>(null);
  const [failed, setFailed] = useState(false);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const narrow = (width ?? 0) < 720;
  const labelLeft = narrow ? 112 : 228;
  const labelRight = narrow ? 140 : 250;
  /** The ribbons' least width; on a phone the names need the room more. */
  const middle = narrow ? 72 : 120;

  useEffect(() => {
    const data = dataRef.current;
    if (width === null || data.nodes.length === 0) return;
    let cancelled = false;
    const rows = Math.max(
      ...(["ask", "capability"] as const).map(
        (side) => data.nodes.filter((node) => node.side === side).length,
      ),
    );
    const height = Math.max(MIN_HEIGHT, rows * ROW + 16);
    import("d3-sankey").then(
      ({ sankey, sankeyLinkHorizontal }) => {
        if (cancelled) return;
        const generator = sankey<FlowNode, FlowLink>()
          .nodeId((node) => node.id)
          .nodeWidth(6)
          .nodePadding(14)
          // Null keeps the order `buildFlowData` chose (tasks in bands, the right side by barycentre).
          .nodeSort(
            null as unknown as (
              a: SankeyNode<FlowNode, FlowLink>,
              b: SankeyNode<FlowNode, FlowLink>,
            ) => number,
          )
          .extent([
            [labelLeft, 8],
            [Math.max(labelLeft + middle, width - labelRight), height - 8],
          ]);
        const graph = generator({
          nodes: data.nodes.map((node) => ({ ...node })),
          links: data.links.map((link) => ({ ...link })),
        });
        const path = sankeyLinkHorizontal<FlowNode, FlowLink>();
        setPlaced({
          key: layoutKey,
          width,
          layout: {
            nodes: graph.nodes,
            links: graph.links.map((link) => Object.assign(link, { path: path(link) ?? "" })),
            height,
          },
        });
      },
      (error: unknown) => {
        if (cancelled) return;
        captureClientException(error, { digest: null, pathname: pathname ?? "", boundary: "app" });
        setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [layoutKey, labelLeft, labelRight, middle, pathname, width]);

  if (data.nodes.length === 0) {
    return (
      <div className={cn("rounded-lg border border-line", className)}>
        <EmptyState
          title="Nothing to trace yet"
          description="Ribbons appear once intents' asks call tools."
        />
      </div>
    );
  }
  if (failed) {
    return (
      <div className={cn("rounded-lg border border-line p-4", className)}>
        <Callout tone="warning" title="The flow could not be drawn">
          All intents lists the same intents.
        </Callout>
      </div>
    );
  }

  // The last layout stays up while a new one is placed, so the view never blanks.
  const layout = placed?.layout ?? null;
  // Names come from the current data: a label can change without a new layout.
  const current = new Map(data.nodes.map((node) => [node.id, node]));
  const selectedRow = selectedId
    ? (data.nodes.find((node) => node.ref === selectedId)?.id ?? null)
    : null;
  const focus = hover ?? selectedRow;
  const linkKey = (link: { source: unknown; target: unknown }) =>
    `${(link.source as FlowNode).id}|${(link.target as FlowNode).id}`;
  const litLink = (link: SankeyLink<FlowNode, FlowLink>) => {
    if (!focus) return false;
    const source = (link.source as FlowNode).id;
    const target = (link.target as FlowNode).id;
    return focus === source || focus === target || focus === `${source}|${target}`;
  };
  const litNode = (node: FlowNode) => {
    if (!focus) return false;
    if (focus === node.id) return true;
    return Boolean(
      layout?.links.some(
        (link) =>
          litLink(link) &&
          ((link.source as FlowNode).id === node.id || (link.target as FlowNode).id === node.id),
      ),
    );
  };
  const firstLeft = layout?.nodes.find((node) => node.side === "ask");
  const firstRight = layout?.nodes.find((node) => node.side === "capability");

  return (
    <div ref={containerRef} className={cn("relative w-full", className)} data-flow-lens="">
      {!layout ? (
        <div className="flex h-[348px] items-center justify-center rounded-lg border border-line">
          <MapLoader label="Drawing the flow" />
        </div>
      ) : (
        <>
          {/* What each side is, by its noun's icon. */}
          <div
            aria-hidden
            className="relative h-7 text-xs font-medium text-fg-muted"
            style={{ marginBottom: HEADER - 28 }}
          >
            {firstLeft ? (
              <span
                className="absolute top-1 flex items-center gap-1.5"
                style={{ right: (width ?? 0) - (firstLeft.x0 ?? 0) + 8 }}
              >
                <NounIcon noun="intent" />
                Intents
              </span>
            ) : null}
            {firstRight ? (
              <span
                className="absolute top-1 flex items-center gap-1.5"
                style={{ left: (firstRight.x1 ?? 0) + 8 }}
              >
                <NounIcon noun="tool" />
                Tools
              </span>
            ) : null}
          </div>
          <svg
            width={width ?? 0}
            height={layout.height}
            role="group"
            aria-label={`Flow from ${data.nodes.filter((node) => node.side === "ask").length} intents to the tools their asks called, in calls`}
            className="block select-none"
            onPointerLeave={() => setHover(null)}
          >
            <g aria-hidden>
              {layout.links.map((link) => {
                const lit = litLink(link);
                const ribbon = Math.max(1, link.width ?? 1);
                const tint = link.tint;
                return (
                  <path
                    key={linkKey(link)}
                    d={link.path}
                    data-tint={tint ?? undefined}
                    onPointerEnter={() => setHover(linkKey(link))}
                    className={cn(
                      "fill-none transition-[stroke-opacity] duration-120 motion-reduce:transition-none",
                      tint ? RIBBON[tint] : "stroke-fg-faint",
                    )}
                    style={{
                      strokeWidth: ribbon,
                      strokeOpacity: lit
                        ? 0.7
                        : focus
                          ? 0.06
                          : ribbonOpacity(ribbon, tint !== null),
                    }}
                  />
                );
              })}
            </g>
            {layout.nodes.map((node) => {
              const left = node.side === "ask";
              const lit = litNode(node);
              const x0 = node.x0 ?? 0;
              const x1 = node.x1 ?? 0;
              const y0 = node.y0 ?? 0;
              const y1 = node.y1 ?? 0;
              const y = (y0 + y1) / 2;
              const budget = left ? (narrow ? 14 : 30) : narrow ? 14 : 32;
              const interactive = node.ref !== null;
              const shown = current.get(node.id) ?? node;
              const mono = !left && shown.kind !== null;
              const name = mono ? middleCut(shown.label, budget) : shorten(shown.label, budget);
              const count = shown.value.toLocaleString("en-US");
              const room = left ? x0 - 8 : (width ?? 0) - x1 - 8;
              const fits = labelWidth(name, 12, mono) + 6 + labelWidth(count, 12) <= room;
              return (
                <g
                  key={node.id}
                  role={interactive ? "button" : undefined}
                  tabIndex={interactive ? 0 : undefined}
                  aria-label={flowNodeName(shown)}
                  data-row={node.ref ?? undefined}
                  className={cn(
                    "outline-none transition-opacity duration-120 motion-reduce:transition-none focus-visible:[&>rect]:stroke-accent-mark",
                    interactive && "cursor-pointer",
                    focus && !lit && "opacity-40",
                  )}
                  onPointerEnter={() => setHover(node.id)}
                  onFocus={() => setHover(node.id)}
                  onBlur={() => setHover(null)}
                  onClick={() => {
                    if (node.ref) onOpen(node.ref);
                  }}
                  onKeyDown={(event) => {
                    if (node.ref && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      onOpen(node.ref);
                    }
                  }}
                >
                  <rect
                    x={x0}
                    y={y0}
                    width={Math.max(1, x1 - x0)}
                    height={Math.max(2, y1 - y0)}
                    rx={2}
                    className={cn(
                      "[stroke-width:2px] stroke-transparent",
                      selectedRow === node.id
                        ? "fill-accent-mark"
                        : node.tint
                          ? BAR[node.tint]
                          : lit
                            ? "fill-fg"
                            : node.ref === null
                              ? "fill-line-active"
                              : "fill-fg-subtle",
                    )}
                  />
                  {/* A row-high hit area, so thin rows are as easy to hover as thick ones. */}
                  <rect
                    x={left ? 0 : x0}
                    y={y - 11}
                    width={left ? x1 : (width ?? 0) - x0}
                    height={22}
                    className="fill-transparent"
                  />
                  <text
                    x={left ? x0 - 8 : x1 + 8}
                    y={y}
                    textAnchor={left ? "end" : "start"}
                    dominantBaseline="central"
                    className={cn(
                      "text-xs",
                      !left && node.kind !== null && "font-mono",
                      lit ? "fill-fg" : "fill-fg-muted",
                    )}
                  >
                    {/* A tool's id is cut in its middle, keeping both ends; an intent's name at its end. */}
                    <tspan>{name}</tspan>
                    {/* The count when it fits beside the name (a phone may only have room for the name). */}
                    {fits ? (
                      <tspan dx={6} className="font-sans fill-fg-subtle tabular-nums">
                        {count}
                      </tspan>
                    ) : null}
                  </text>
                </g>
              );
            })}
          </svg>
        </>
      )}
    </div>
  );
}
