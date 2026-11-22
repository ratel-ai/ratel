"use client";

import { useRouter } from "next/navigation";
import { formatInteger } from "@/lib/synthesis/traces/v2/format";
import type { HandoffMapLayout, MapNode } from "@/lib/views/project-entities/agents-model";

/**
 * The handoff map (the approved RP-25 design): who hands work to whom, left to right. A box's
 * size is its runs, an edge's width its handoffs, a red box an agent past 10% errors. A click on
 * a box opens the agent. The page leaves it out when no agent hands work off.
 */
export function AgentHandoffMap({
  layout,
  hrefs,
}: {
  layout: HandoffMapLayout;
  hrefs: Record<string, string>;
}) {
  const router = useRouter();
  const nodes = new Map(layout.nodes.map((node) => [node.key, node]));
  return (
    <section
      aria-labelledby="handoff-map-title"
      className="flex w-full shrink-0 flex-col rounded-lg border border-line bg-raised xl:w-[22rem]"
    >
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 id="handoff-map-title" className="text-sm font-semibold text-fg">
          Handoff map
        </h2>
        <span className="flex items-center gap-3 text-xs text-fg-subtle">
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="size-1.5 rounded-full bg-success" />
            healthy
          </span>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="size-1.5 rounded-full bg-danger" />
            &gt;10% errors
          </span>
        </span>
      </header>
      <div className="overflow-x-auto px-3 py-10">
        <svg
          role="img"
          aria-label="Handoffs between agents"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width="100%"
          style={{ maxWidth: layout.width }}
          className="mx-auto block overflow-visible"
        >
          <defs>
            <marker
              id="handoff-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerUnits="userSpaceOnUse"
              markerWidth="9"
              markerHeight="9"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L8,4 L0,8 z" fill="var(--color-fg-subtle)" />
            </marker>
          </defs>
          {layout.edges.map((edge) => {
            const from = nodes.get(edge.from);
            const to = nodes.get(edge.to);
            if (!from || !to) return null;
            const x1 = from.x + from.width;
            const y1 = from.y + from.height / 2;
            const x2 = to.x - 2;
            const y2 = to.y + to.height / 2;
            const mid = (x1 + x2) / 2;
            return (
              <g key={`${edge.from}|${edge.to}`}>
                <path
                  d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                  fill="none"
                  stroke="var(--color-fg-subtle)"
                  strokeOpacity={0.7}
                  strokeWidth={edge.width}
                  markerEnd="url(#handoff-arrow)"
                />
                <text
                  x={mid}
                  y={(y1 + y2) / 2 - edge.width / 2 - 4}
                  textAnchor="middle"
                  className="fill-fg-subtle text-[10px] tabular-nums"
                >
                  {formatInteger(edge.count)}
                </text>
              </g>
            );
          })}
          {layout.nodes.map((node) => (
            <MapBox
              key={node.key}
              node={node}
              onOpen={() => {
                const href = hrefs[node.key];
                if (href) router.push(href);
              }}
            />
          ))}
        </svg>
      </div>
      <p className="border-t border-line px-4 py-3 text-xs text-fg-subtle">
        Left to right: who hands work to whom. Box size is runs, edge width is handoffs. Click an
        agent to open it.
      </p>
    </section>
  );
}

function MapBox({ node, onOpen }: { node: MapNode; onOpen: () => void }) {
  const showRuns = node.height >= 38;
  return (
    // biome-ignore lint/a11y/useSemanticElements: an SVG group has no button element; it takes the role.
    <g
      role="button"
      tabIndex={0}
      aria-label={`Open ${node.name}`}
      className="cursor-pointer outline-none focus-visible:[&>rect]:stroke-focus"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <rect
        x={node.x}
        y={node.y}
        width={node.width}
        height={node.height}
        rx={6}
        fill={node.failing ? "var(--color-danger-subtle)" : "var(--color-app)"}
        stroke={node.failing ? "var(--color-danger)" : "var(--color-line-strong)"}
        strokeWidth={1}
      />
      <text
        x={node.x + node.width / 2}
        y={node.y + (showRuns ? node.height / 2 - 2 : node.height / 2 + 4)}
        textAnchor="middle"
        className="fill-fg text-[11px] font-semibold"
      >
        {node.name.length > 16 ? `${node.name.slice(0, 15)}…` : node.name}
      </text>
      {showRuns ? (
        <text
          x={node.x + node.width / 2}
          y={node.y + node.height / 2 + 11}
          textAnchor="middle"
          className={`font-mono text-[9px] tabular-nums ${node.failing ? "fill-danger" : "fill-fg-subtle"}`}
        >
          {formatInteger(node.runs)} runs
        </text>
      ) : null}
    </g>
  );
}
