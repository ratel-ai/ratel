import type { McpRole } from "@/lib/ingest/otlp/dimensions";
import type { getDb } from "@/lib/platform/db/client";
import { overrideView } from "../agents/domain/overrides";
import { rateOf } from "../agents/domain/types";
import type { AgentStore } from "../agents/ports/store";
import { listMcpServers } from "../mcp-servers/queries";
import { AGENT_ERROR_PILL_RATE, type Handoff } from "./agents-model";
import { type AgentMcpCalls, type EntityWindow, listAgentMcpCalls } from "./queries";

/**
 * The topology of a project: its agents and MCP servers, who hands work to
 * whom and who calls which server, in one bounded graph.
 */

export type TopologyNodeKind = "agent" | "mcp" | "project";

export interface TopologyNode {
  /** Unique in the graph: an agent and a server can share a key. */
  id: string;
  kind: TopologyNodeKind;
  /** The agent's or the server's key; empty for the project. */
  key: string;
  name: string;
  /** Runs of an agent; calls of a server; calls the project makes with no agent. */
  count: number;
  errorRate: number;
  failing: boolean;
}

export interface TopologyEdge {
  kind: "handoff" | "call";
  /** Node ids. */
  from: string;
  to: string;
  count: number;
  /** Null for a handoff: it keeps no errors of its own. */
  errors: number | null;
}

export interface Topology {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  /** The nodes the caps left out. `atLeast`: the reads were cut too, so there are more. */
  omitted: { agents: number; servers: number; atLeast: boolean };
}

export interface TopologyRows {
  agents: readonly { key: string; displayName: string; calls: number; errorRate: number }[];
  handoffs: readonly Handoff[];
  servers: readonly {
    key: string;
    role: McpRole;
    displayName: string;
    calls: number;
    errorRate: number;
  }[];
  calls: readonly AgentMcpCalls[];
  hidden: ReadonlySet<string>;
  names: ReadonlyMap<string, string>;
}

export const MAX_TOPOLOGY_AGENTS = 12;
export const MAX_TOPOLOGY_SERVERS = 8;
/** The row limit of `listAgents` and `listMcpServers`. */
const READ_LIMIT = 200;
const PROJECT_NODE_ID = "project";

export async function readTopology(
  projectId: string,
  window: EntityWindow,
  deps: { agents: AgentStore; db: Pick<ReturnType<typeof getDb>, "execute"> },
): Promise<Topology> {
  const view = overrideView(await deps.agents.listOverrides(projectId));
  const [list, handoffs, mcp, calls] = await Promise.all([
    // Hidden agents count against the read's limit; the model drops them.
    deps.agents.listAgents(projectId, window, { showHidden: true }),
    deps.agents.listHandoffs(projectId, window),
    listMcpServers(projectId, window, deps.db),
    listAgentMcpCalls(projectId, window, view.merges, deps.db),
  ]);
  return topologyModel({
    agents: list.agents,
    handoffs,
    servers: mcp.servers,
    calls,
    hidden: view.hidden,
    names: view.names,
  });
}

/** The graph of the rows: hidden agents dropped, both roles of a server as one node, nodes capped busiest first. */
export function topologyModel(rows: TopologyRows): Topology {
  const agents = busiestFirst(agentNodes(rows));
  const servers = busiestFirst(serverNodes(rows));
  const project = projectNode(rows.calls);
  const nodes = [
    ...(project ? [project] : []),
    ...agents.slice(0, MAX_TOPOLOGY_AGENTS),
    ...servers.slice(0, MAX_TOPOLOGY_SERVERS),
  ];
  const drawn = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    edges: edgesOf(rows).filter((edge) => drawn.has(edge.from) && drawn.has(edge.to)),
    omitted: {
      agents: Math.max(0, agents.length - MAX_TOPOLOGY_AGENTS),
      servers: Math.max(0, servers.length - MAX_TOPOLOGY_SERVERS),
      atLeast: rows.agents.length >= READ_LIMIT || rows.servers.length >= READ_LIMIT,
    },
  };
}

// — Helpers ——————————————————————————————————————————————————————————————————

function agentNodes(rows: TopologyRows): TopologyNode[] {
  const nodes = new Map<string, TopologyNode>();
  const add = (key: string, name: string, count: number, errorRate: number) => {
    if (!rows.hidden.has(key) && !nodes.has(key))
      nodes.set(key, node("agent", key, name, count, errorRate));
  };
  for (const agent of rows.agents) add(agent.key, agent.displayName, agent.calls, agent.errorRate);
  // An agent seen only at the end of an edge has no run of its own in the list.
  for (const edge of rows.handoffs) {
    add(edge.from, edge.fromName, 0, 0);
    add(edge.to, edge.toName, 0, 0);
  }
  for (const call of rows.calls)
    if (call.agent !== null) add(call.agent, rows.names.get(call.agent) ?? call.agent, 0, 0);
  return [...nodes.values()];
}

/** The two roles count the same calls from two processes, so the busier one stands for the server. */
function serverNodes(rows: TopologyRows): TopologyNode[] {
  const nodes = new Map<string, TopologyNode>();
  for (const row of [...rows.servers].sort((a, b) => b.calls - a.calls))
    if (!nodes.has(row.key))
      nodes.set(row.key, node("mcp", row.key, row.displayName, row.calls, row.errorRate));
  return [...nodes.values()];
}

/** Where the calls with no agent come from. */
function projectNode(calls: readonly AgentMcpCalls[]): TopologyNode | null {
  const own = calls.filter((call) => call.agent === null);
  if (own.length === 0) return null;
  const count = own.reduce((sum, call) => sum + call.calls, 0);
  const errors = own.reduce((sum, call) => sum + call.errors, 0);
  return node("project", "", "This project", count, rateOf(errors, count));
}

function edgesOf(rows: TopologyRows): TopologyEdge[] {
  const edges: TopologyEdge[] = [
    ...rows.handoffs.map((edge) => ({
      kind: "handoff" as const,
      from: nodeId("agent", edge.from),
      to: nodeId("agent", edge.to),
      count: edge.count,
      errors: null,
    })),
    ...rows.calls.map((call) => ({
      kind: "call" as const,
      from: call.agent === null ? PROJECT_NODE_ID : nodeId("agent", call.agent),
      to: nodeId("mcp", call.server),
      count: call.calls,
      errors: call.errors,
    })),
  ];
  return edges.sort(
    (a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
}

function node(
  kind: TopologyNodeKind,
  key: string,
  name: string,
  count: number,
  errorRate: number,
): TopologyNode {
  return {
    id: nodeId(kind, key),
    kind,
    key,
    name,
    count,
    errorRate,
    failing: errorRate > AGENT_ERROR_PILL_RATE,
  };
}

function nodeId(kind: TopologyNodeKind, key: string): string {
  return kind === "project" ? PROJECT_NODE_ID : `${kind}:${key}`;
}

function busiestFirst(nodes: readonly TopologyNode[]): TopologyNode[] {
  return [...nodes].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}
