import { cn } from "@ratel/design-system/cn";
import { Bot, Box, type LucideIcon, Server } from "lucide-react";
import type { TopologyNodeKind } from "@/lib/views/project-entities/topology";
import type { PlacedEdge, PlacedNode } from "@/lib/views/project-entities/topology-layout";

/** What the map and the example of an empty map are drawn with: the cards, the lines and their arrowheads. */

const ICONS: Record<TopologyNodeKind, LucideIcon> = { agent: Bot, mcp: Server, project: Box };
const NAME_LENGTH = 19;

/** The arrowheads of one SVG: `id`, and `id` with "-failing" where an edge can fail. Unique in the page. */
export function TopologyArrows({ id, failing = false }: { id: string; failing?: boolean }) {
  return (
    <defs>
      <Arrow id={id} color="var(--color-fg-subtle)" />
      {failing ? <Arrow id={`${id}-failing`} color="var(--color-danger)" /> : null}
    </defs>
  );
}

export function TopologyEdgePath({
  edge,
  arrow,
  failing = false,
  title,
}: {
  edge: PlacedEdge;
  /** The id of `TopologyArrows`. */
  arrow: string;
  failing?: boolean;
  title?: string;
}) {
  return (
    <path
      d={edge.path}
      fill="none"
      stroke={failing ? "var(--color-danger)" : "var(--color-fg-subtle)"}
      strokeOpacity={0.7}
      strokeWidth={edge.width}
      markerEnd={failing ? `url(#${arrow}-failing)` : `url(#${arrow})`}
      data-topology-edge={edge.kind}
    >
      {title ? <title>{title}</title> : null}
    </path>
  );
}

export function TopologyNodeCard({
  node,
  detail,
  title,
  quiet = false,
}: {
  node: PlacedNode;
  /** Under the name. */
  detail: string;
  title?: string;
  /** Steps back behind a live map's cards. */
  quiet?: boolean;
}) {
  const Icon = ICONS[node.kind];
  return (
    <g data-topology-node={node.kind}>
      {title ? <title>{title}</title> : null}
      <rect
        x={node.x}
        y={node.y}
        width={node.width}
        height={node.height}
        rx={6}
        fill={
          node.failing
            ? "var(--color-danger-subtle)"
            : quiet
              ? "var(--color-raised)"
              : "var(--color-app)"
        }
        stroke={node.failing ? "var(--color-danger)" : "var(--color-line-strong)"}
      />
      <Icon
        aria-hidden
        x={node.x + 11}
        y={node.y + 14}
        width={16}
        height={16}
        strokeWidth={1.5}
        className={node.failing ? "text-danger" : quiet ? "text-fg-subtle" : "text-fg-muted"}
      />
      <text
        x={node.x + 36}
        y={node.y + 19}
        className={cn("text-xs font-semibold", quiet ? "fill-fg-muted" : "fill-fg")}
      >
        {shortName(node.name)}
      </text>
      <text
        x={node.x + 36}
        y={node.y + 34}
        className={`text-xs tabular-nums ${node.failing ? "fill-danger" : "fill-fg-subtle"}`}
      >
        {detail}
      </text>
    </g>
  );
}

function Arrow({ id, color }: { id: string; color: string }) {
  return (
    <marker
      id={id}
      viewBox="0 0 8 8"
      refX="7"
      refY="4"
      markerUnits="userSpaceOnUse"
      markerWidth="9"
      markerHeight="9"
      orient="auto-start-reverse"
    >
      <path d="M0,0 L8,4 L0,8 z" fill={color} />
    </marker>
  );
}

function shortName(name: string): string {
  return name.length > NAME_LENGTH ? `${name.slice(0, NAME_LENGTH - 1)}…` : name;
}
