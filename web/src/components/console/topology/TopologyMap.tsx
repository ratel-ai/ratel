import { cn } from "@ratel/design-system/cn";
import { Bot, Box, type LucideIcon, Server } from "lucide-react";
import Link from "next/link";
import type { EmptyWindow } from "@/components/console/home/focused/WidgetEmpty";
import { TopologyEmpty } from "@/components/console/topology/TopologyEmpty";
import { formatInteger, formatPercent } from "@/lib/synthesis/traces/v2/format";
import { agentHref, agentsHref } from "@/lib/views/agents/paths";
import { mcpServerHref, mcpServersHref } from "@/lib/views/mcp-servers/paths";
import { AGENT_ERROR_PILL_RATE } from "@/lib/views/project-entities/agents-model";
import type {
  Topology,
  TopologyNode,
  TopologyNodeKind,
} from "@/lib/views/project-entities/topology";
import {
  type PlacedEdge,
  type PlacedNode,
  topologyLayout,
} from "@/lib/views/project-entities/topology-layout";

const ICONS: Record<TopologyNodeKind, LucideIcon> = { agent: Bot, mcp: Server, project: Box };
const NAME_LENGTH = 19;

/**
 * The topology of a project: its agents by handoff depth, left to right, then
 * the MCP servers they call. The map scrolls inside its card where it does not
 * fit, and a list says the same to a screen reader.
 */
export function TopologyMap({
  projectId,
  graph,
  range,
  linked,
  bare = false,
  empty,
}: {
  projectId: string;
  graph: Topology;
  /** The window the links keep, such as `7d`. */
  range: string;
  /** The Agents and MCP servers pages exist (`agentsPages`). */
  linked: boolean;
  /** A widget, without a frame: the map fills it and scrolls both ways. */
  bare?: boolean;
  /** What an empty map says. */
  empty: EmptyWindow;
}) {
  const layout = topologyLayout(graph);
  const hrefOf = (node: TopologyNode) => (linked ? nodeHref(projectId, node, range) : null);
  const has = (kind: TopologyNodeKind) => graph.nodes.some((node) => node.kind === kind);
  if (graph.nodes.length === 0)
    return (
      <div
        className={bare ? "flex min-h-0 flex-1 flex-col" : "rounded-lg border border-line"}
        data-topology="empty"
      >
        <TopologyEmpty {...empty} />
      </div>
    );
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col",
        bare ? "min-h-0 flex-1" : "rounded-lg border border-line bg-raised",
      )}
      data-topology=""
    >
      <div
        className={cn(
          "flex flex-1",
          bare ? "min-h-0 overflow-auto px-3" : "items-center overflow-x-auto p-3",
        )}
      >
        {/* biome-ignore lint/a11y/useSemanticElements: an SVG has no fieldset; it groups the linked boxes. */}
        <svg
          role="group"
          aria-label="Agents and MCP servers"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width={layout.width}
          height={layout.height}
          className={cn("block shrink-0", bare ? "m-auto" : "mx-auto")}
        >
          <defs>
            <Arrow id="topology-arrow" color="var(--color-fg-subtle)" />
            <Arrow id="topology-arrow-failing" color="var(--color-danger)" />
          </defs>
          {layout.edges.map((edge) => (
            <Edge key={`${edge.from}|${edge.to}`} edge={edge} />
          ))}
          {layout.edges.map((edge) => (
            <text
              key={`${edge.from}|${edge.to}`}
              aria-hidden
              x={edge.label.x}
              y={edge.label.y + 4}
              textAnchor="middle"
              className={cn(
                "fill-fg-muted text-xs tabular-nums [paint-order:stroke]",
                bare ? "stroke-app" : "stroke-raised",
              )}
              strokeWidth={4}
            >
              {formatInteger(edge.count)}
            </text>
          ))}
          {layout.nodes.map((node) => (
            <Node key={node.id} node={node} href={hrefOf(node)} />
          ))}
        </svg>
      </div>
      <ul className="sr-only" aria-label="Agents, MCP servers and their flows">
        {layout.nodes.map((node) => (
          <li key={node.id}>{nodeText(node)}</li>
        ))}
        {layout.edges.map((edge) => (
          <li key={`${edge.from}|${edge.to}`}>{edgeText(edge)}</li>
        ))}
      </ul>
      <footer
        className={cn(
          "flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-xs text-fg-subtle",
          bare ? "" : "border-t border-line",
        )}
      >
        <span className="min-w-0 flex-1 basis-64">{caption(graph)}</span>
        {linked && has("agent") ? (
          <SeeAll href={agentsHref(projectId, { range })}>See all agents</SeeAll>
        ) : null}
        {linked && has("mcp") ? (
          <SeeAll href={mcpServersHref(projectId, { range })}>See all MCP servers</SeeAll>
        ) : null}
      </footer>
    </div>
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

function Edge({ edge }: { edge: PlacedEdge }) {
  const failing = edge.errors !== null && edge.errors > edge.count * AGENT_ERROR_PILL_RATE;
  return (
    <path
      d={edge.path}
      fill="none"
      stroke={failing ? "var(--color-danger)" : "var(--color-fg-subtle)"}
      strokeOpacity={0.7}
      strokeWidth={edge.width}
      markerEnd={failing ? "url(#topology-arrow-failing)" : "url(#topology-arrow)"}
      data-topology-edge={edge.kind}
    >
      <title>{edgeText(edge)}</title>
    </path>
  );
}

function Node({ node, href }: { node: PlacedNode; href: string | null }) {
  const Icon = ICONS[node.kind];
  const box = (
    <g data-topology-node={node.kind}>
      <title>{nodeText(node)}</title>
      <rect
        x={node.x}
        y={node.y}
        width={node.width}
        height={node.height}
        rx={6}
        fill={node.failing ? "var(--color-danger-subtle)" : "var(--color-app)"}
        stroke={node.failing ? "var(--color-danger)" : "var(--color-line-strong)"}
      />
      <Icon
        aria-hidden
        x={node.x + 11}
        y={node.y + 14}
        width={16}
        height={16}
        strokeWidth={1.5}
        className={node.failing ? "text-danger" : "text-fg-muted"}
      />
      <text x={node.x + 36} y={node.y + 19} className="fill-fg text-xs font-semibold">
        {shortName(node.name)}
      </text>
      <text
        x={node.x + 36}
        y={node.y + 34}
        className={`text-xs tabular-nums ${node.failing ? "fill-danger" : "fill-fg-subtle"}`}
      >
        {countText(node)}
        {node.failing ? `, ${formatPercent(node.errorRate)} errors` : null}
      </text>
    </g>
  );
  if (!href) return box;
  return (
    <Link
      href={href}
      aria-label={`Open ${node.name}`}
      className="outline-none hover:[&_rect]:stroke-line-active focus-visible:[&_rect]:stroke-focus focus-visible:[&_rect]:stroke-2"
    >
      {box}
    </Link>
  );
}

function SeeAll({ href, children }: { href: string; children: string }) {
  return (
    <Link
      href={href}
      className="shrink-0 rounded-sm text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
    >
      {children}
    </Link>
  );
}

function nodeHref(projectId: string, node: TopologyNode, range: string): string | null {
  if (node.kind === "agent") return agentHref(projectId, node.key, { range });
  if (node.kind === "mcp") return mcpServerHref(projectId, node.key, { range });
  return null;
}

function nodeText(node: TopologyNode): string {
  const kind = { agent: "Agent ", mcp: "MCP server ", project: "" }[node.kind];
  return `${kind}${node.name}: ${countText(node)}, ${formatPercent(node.errorRate)} errors`;
}

function edgeText(edge: PlacedEdge): string {
  if (edge.kind === "handoff")
    return `${edge.fromName} hands work to ${edge.toName}: ${plural(edge.count, "handoff")}`;
  return `${edge.fromName} calls ${edge.toName}: ${plural(edge.count, "call")}, ${plural(edge.errors ?? 0, "error")}`;
}

function countText(node: TopologyNode): string {
  return plural(node.count, node.kind === "agent" ? "run" : "call");
}

function caption(graph: Topology): string {
  const named = graph.nodes.some((node) => node.kind === "agent");
  const lead = named
    ? "Left to right: who hands work to whom, then the MCP servers they call. Red is past 10% errors."
    : "No span names an agent in this window (gen_ai.agent.name). Red is past 10% errors.";
  const more = omittedText(graph.omitted);
  return more ? `${lead} ${more}` : lead;
}

function omittedText({ agents, servers, atLeast }: Topology["omitted"]): string | null {
  const parts = [
    agents > 0 ? plural(agents, "agent") : null,
    servers > 0 ? plural(servers, "MCP server") : null,
  ].filter((part) => part !== null);
  if (parts.length === 0) return null;
  return `Not drawn: ${atLeast ? "at least " : ""}${parts.join(" and ")} with less traffic.`;
}

function plural(count: number, noun: string): string {
  return `${formatInteger(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function shortName(name: string): string {
  return name.length > NAME_LENGTH ? `${name.slice(0, NAME_LENGTH - 1)}…` : name;
}
