import { Badge } from "@ratel/design-system/badge";
import { cn } from "@ratel/design-system/cn";
import { type EmptyWindow, TracesAction } from "@/components/console/home/focused/WidgetEmpty";
import {
  TopologyArrows,
  TopologyEdgePath,
  TopologyNodeCard,
} from "@/components/console/topology/TopologyParts";
import type { Topology, TopologyNode } from "@/lib/views/project-entities/topology";
import { type TopologySpacing, topologyLayout } from "@/lib/views/project-entities/topology-layout";

const agent = (key: string, name: string) => exampleNode("agent", key, name);
const server = (key: string, name: string) => exampleNode("mcp", key, name);

const YOURS = agent("yours", "Your agent");
const RESEARCH = agent("research", "Research agent");
const SUPPORT = agent("support", "Support agent");
const SEARCH = server("search", "Search");
const CRM = server("crm", "CRM");
const DATABASE = server("database", "Database");

const FULL = exampleGraph([
  [YOURS, RESEARCH],
  [YOURS, SUPPORT],
  [RESEARCH, SEARCH],
  [SUPPORT, CRM],
  [SUPPORT, DATABASE],
]);

/** One of them shows, by the widget's size. Fewer cards in a smaller one. */
const EXAMPLES: readonly {
  size: string;
  graph: Topology;
  spacing: TopologySpacing;
  shown: string;
}[] = [
  {
    size: "wide",
    graph: FULL,
    spacing: { columnGap: 200, padding: 8 },
    shown: "[@container_(width>=1000px)_and_(height>=280px)]:block",
  },
  {
    size: "full",
    graph: FULL,
    spacing: { columnGap: 72, padding: 8 },
    shown: "[@container_(640px<=width<1000px)_and_(height>=280px)]:block",
  },
  {
    size: "row",
    graph: exampleGraph([
      [YOURS, SUPPORT],
      [SUPPORT, CRM],
    ]),
    spacing: { columnGap: 72, padding: 4 },
    shown: "[@container_(width>=640px)_and_(height<280px)]:block",
  },
  {
    size: "tall",
    graph: exampleGraph([
      [YOURS, SEARCH],
      [YOURS, CRM],
      [YOURS, DATABASE],
    ]),
    spacing: { boxWidth: 112, columnGap: 40, padding: 4 },
    shown: "[@container_(width<640px)_and_(height>=280px)]:block",
  },
  {
    size: "pair",
    graph: exampleGraph([[YOURS, SEARCH]]),
    spacing: { boxWidth: 112, columnGap: 40, padding: 4 },
    shown: "[@container_(width<640px)_and_(height<280px)]:block",
  },
];
/** Where the corner of the example is free, the badge is there; else it is on the edge under it. */
const IN_CORNER = "hidden [@container_(height>=280px)_or_(width>=640px)]:block";
const ON_EDGE = "[@container_(height>=280px)_or_(width>=640px)]:hidden";

/** The longest words need the whole of the smallest widget. */
const NO_ROOM = "[@container_(width<300px)_and_(height<280px)]:hidden";
/** More than this and the cards outgrow the words. */
const MAX_SCALE = 1.25;

/**
 * The map before there is anything on it: an example map, drawn as the real one and marked as an
 * example, and under it what is missing (no traces yet, none in the window, or none that names an
 * agent). The example is decoration: the words carry the meaning.
 */
export function TopologyEmpty(at: EmptyWindow) {
  const { name, title, description } = copy(at);
  const unpictured = name === "topology-unnamed" ? NO_ROOM : undefined;
  return (
    <div
      data-widget-empty={name}
      // Its place gives the size, so that the example can follow it. Below `lg` a place has no height.
      className="min-h-96 flex-1 overflow-y-auto [container-type:size] lg:min-h-0"
    >
      <div className="flex min-h-full flex-col justify-center gap-3 p-3">
        <div className={cn("relative min-h-11 flex-1", unpictured)}>
          {EXAMPLES.map((example) => (
            <ExampleMap key={example.size} {...example} />
          ))}
          <span aria-hidden="true" className={cn("absolute top-0 left-0", IN_CORNER)}>
            <Badge>Example</Badge>
          </span>
        </div>
        <div className="relative flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-line bg-raised px-3 py-2">
          <span
            aria-hidden="true"
            className={cn("absolute -top-3 right-2 rounded-md bg-app", ON_EDGE, unpictured)}
          >
            <Badge>Example</Badge>
          </span>
          <div className="min-w-0 flex-1 basis-44 text-ui">
            <p className="font-semibold text-fg">{title}</p>
            <p className="text-fg-muted">{description}</p>
          </div>
          <TracesAction {...at} />
        </div>
      </div>
    </div>
  );
}

function copy({ tracesSeen, window }: EmptyWindow) {
  if (tracesSeen === "none")
    return {
      name: "topology-none",
      title: "No traces yet",
      description: "Send traces and your agents and MCP servers show up here.",
    };
  if (tracesSeen === "before")
    return {
      name: "topology-window",
      title: `No traces in the last ${window} days`,
      description: "Send traces and your agents and MCP servers show up here again.",
    };
  return {
    name: "topology-unnamed",
    title: "No agents or MCP servers in this window",
    description: "Send traces whose spans name an agent (gen_ai.agent.name) or call an MCP server.",
  };
}

function ExampleMap({ size, graph, spacing, shown }: (typeof EXAMPLES)[number]) {
  const layout = topologyLayout(graph, spacing);
  const arrow = `topology-example-${size}`;
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      className={cn("absolute inset-0 m-auto hidden size-full", shown)}
      style={{ maxWidth: layout.width * MAX_SCALE, maxHeight: layout.height * MAX_SCALE }}
      data-topology-example={size}
    >
      <TopologyArrows id={arrow} />
      {layout.edges.map((edge) => (
        <TopologyEdgePath key={`${edge.from}|${edge.to}`} edge={edge} arrow={arrow} />
      ))}
      {layout.nodes.map((node) => (
        <TopologyNodeCard
          key={node.id}
          node={node}
          detail={node.kind === "agent" ? "Agent" : "MCP server"}
          quiet
        />
      ))}
    </svg>
  );
}

function exampleNode(kind: "agent" | "mcp", key: string, name: string): TopologyNode {
  return { id: `${kind}:${key}`, kind, key, name, count: 0, errorRate: 0, failing: false };
}

function exampleGraph(pairs: readonly (readonly [TopologyNode, TopologyNode])[]): Topology {
  return {
    nodes: [...new Set(pairs.flat())],
    edges: pairs.map(([from, to]) => ({
      kind: to.kind === "agent" ? "handoff" : "call",
      from: from.id,
      to: to.id,
      // No traffic: every line has the same, thinnest stroke.
      count: 0,
      errors: null,
    })),
    omitted: { agents: 0, servers: 0, atLeast: false },
  };
}
