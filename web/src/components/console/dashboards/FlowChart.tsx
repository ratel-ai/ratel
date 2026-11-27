"use client";

import { cn } from "@ratel/design-system/cn";
import { EmptyState } from "@ratel/design-system/states";
import type { SankeyLink, SankeyNode } from "d3-sankey";
import { CircleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { middleCut } from "@/components/console/intent-map/network-labels";
import type { FlowEdge, FlowResult } from "@/lib/synthesis/metrics/flow";
import { formatInteger } from "@/lib/synthesis/traces/v2/format";
import {
  type FlowModelLink,
  type FlowModelNode,
  flowModel,
} from "@/lib/views/dashboards/flow-model";
import { SampleNote } from "./SampleNote";
import { useSize } from "./use-size";

type PlacedNode = SankeyNode<FlowModelNode, FlowModelLink>;
type PlacedLink = SankeyLink<FlowModelNode, FlowModelLink>;

const NODE_WIDTH = 8;
const NODE_PADDING = 14;
const MIN_HEIGHT = 120;
/** Between a node and its label. */
const LABEL_GAP = 6;
/** About the width of a character of the label. */
const CHARACTER = 6.6;
/** The characters kept for the count after the name. */
const COUNT_ROOM = 5;

/** Written out whole: the only colors a node can have. */
const SLOT_COLOR = [
  "var(--ds-chart-1)",
  "var(--ds-chart-2)",
  "var(--ds-chart-3)",
  "var(--ds-chart-4)",
  "var(--ds-chart-5)",
  "var(--ds-chart-6)",
] as const;
const OTHER_COLOR = "var(--ds-fg-faint)";

/**
 * How traces move, as a compact sankey: one column per step, a ribbon as wide as its traces. Hover
 * or focus a ribbon to trace it; it opens those traces. `d3-sankey` is loaded in the browser only.
 */
export function FlowChart({
  result,
  label,
  noun,
  edgeHref,
  fill = false,
}: {
  result: FlowResult;
  /** The flow, for its accessible name. */
  label: string;
  /** The plural of what a node is. */
  noun: string;
  edgeHref: (edge: FlowEdge) => string;
  /** Take the height of the place it is in. */
  fill?: boolean;
}) {
  const [hostRef, { width, height }] = useSize<HTMLDivElement>();
  const model = useMemo(() => flowModel(result.edges), [result.edges]);
  const [placed, setPlaced] = useState<{ nodes: PlacedNode[]; links: (PlacedLink & Drawn)[] }>();
  const [failed, setFailed] = useState(false);
  const [lit, setLit] = useState<string | null>(null);
  const plotHeight = Math.max(MIN_HEIGHT, height);
  const column = width / Math.max(1, model.columns);

  useEffect(() => {
    if (width === 0) return;
    let stale = false;
    import("d3-sankey").then(
      ({ sankey, sankeyLeft, sankeyLinkHorizontal }) => {
        if (stale) return;
        const tallest = Math.max(
          ...Array.from(
            { length: model.columns },
            (_, index) => model.nodes.filter(({ step }) => step === index + 1).length,
          ),
        );
        const { nodes, links } = sankey<FlowModelNode, FlowModelLink>()
          .nodeId(({ id }) => id)
          .nodeAlign(sankeyLeft)
          .nodeWidth(NODE_WIDTH)
          // Many nodes get less room apart, so they all fit.
          .nodePadding(Math.min(NODE_PADDING, plotHeight / 2 / Math.max(1, tallest)))
          .extent([
            [1, 4],
            // The last column's labels are beside it, as every other one's.
            [Math.max(NODE_WIDTH * 2, width - column), plotHeight - 4],
          ])({
          nodes: model.nodes.map((node) => ({ ...node })),
          links: model.links.map((link) => ({ ...link })),
        });
        const path = sankeyLinkHorizontal<FlowModelNode, FlowModelLink>();
        setPlaced({
          nodes,
          links: links.map((link) => ({ ...link, path: path(link) ?? "" })),
        });
      },
      () => !stale && setFailed(true),
    );
    return () => {
      stale = true;
    };
  }, [model, width, plotHeight, column]);

  if (failed)
    return (
      <EmptyState
        icon={CircleAlert}
        title="The flow could not be drawn"
        description="Reload the page to try again."
      />
    );
  const room = Math.max(4, Math.floor((column - NODE_WIDTH - LABEL_GAP) / CHARACTER) - COUNT_ROOM);
  return (
    <div className={cn("flex min-w-0 flex-col", fill ? "h-full" : "h-72")}>
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden">
        {placed && width > 0 ? (
          // biome-ignore lint/a11y/useSemanticElements: an svg is no fieldset.
          <svg
            width={width}
            height={plotHeight}
            role="group"
            aria-label={`${label}: ${model.links.length} moves between ${noun}`}
            className="block select-none"
            onPointerLeave={() => setLit(null)}
          >
            {placed.links.map((link) => {
              const source = link.source as PlacedNode;
              const target = link.target as PlacedNode;
              const key = `${source.id}>${target.id}`;
              const { edge } = link;
              const name = `${edge.source} to ${edge.target}, step ${edge.step}: ${formatInteger(edge.count)} trace${edge.count === 1 ? "" : "s"}`;
              return (
                <Link
                  key={key}
                  href={edgeHref(edge)}
                  aria-label={name}
                  className="outline-none [&:focus-visible>path]:[stroke-opacity:0.85]"
                  onPointerEnter={() => setLit(key)}
                  onFocus={() => setLit(key)}
                  onBlur={() => setLit(null)}
                >
                  <title>{name}</title>
                  <path
                    d={link.path}
                    className="fill-none transition-[stroke-opacity] duration-120 motion-reduce:transition-none"
                    style={{
                      stroke: colorOf(source),
                      strokeWidth: Math.max(2, link.width ?? 1),
                      strokeOpacity: lit === key ? 0.7 : lit ? 0.1 : 0.35,
                    }}
                  />
                </Link>
              );
            })}
            {placed.nodes.map((node) => {
              const { x0 = 0, x1 = 0, y0 = 0, y1 = 0 } = node;
              const faded = lit !== null && !lit.split(">").includes(node.id);
              return (
                <g
                  key={node.id}
                  className={cn("pointer-events-none", faded && "opacity-40")}
                  aria-hidden
                >
                  <rect
                    x={x0}
                    y={y0}
                    width={x1 - x0}
                    height={Math.max(2, y1 - y0)}
                    rx={2}
                    style={{ fill: colorOf(node) }}
                  />
                  <text
                    x={x1 + LABEL_GAP}
                    y={(y0 + y1) / 2}
                    dominantBaseline="central"
                    className="fill-fg stroke-app text-xs [paint-order:stroke] [stroke-width:3px]"
                  >
                    {middleCut(node.name, room)}
                    <tspan dx={4} className="fill-fg-muted tabular-nums">
                      {formatInteger(node.value ?? 0)}
                    </tspan>
                  </text>
                </g>
              );
            })}
          </svg>
        ) : null}
      </div>
      <SampleNote
        sample={result.sample}
        more={
          result.moreEdges > 0
            ? `${formatInteger(result.moreEdges)} smaller move${result.moreEdges === 1 ? " is" : "s are"} not drawn.`
            : undefined
        }
      />
    </div>
  );
}

interface Drawn {
  path: string;
}

function colorOf({ slot }: FlowModelNode): string {
  return slot === null ? OTHER_COLOR : SLOT_COLOR[slot];
}
