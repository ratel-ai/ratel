import type {
  NetworkLink,
  NetworkNode,
  ToolNetworkModel,
} from "@/lib/views/intents/map/tool-network";
import type { AgentHandoff } from "./types";

/**
 * The handoff graph (RC-775) in the shape the tool network layout settles
 * (`lib/intent-graph/v2/tool-network-layout.ts`): one mark per agent, sized by
 * its runs, and one directed link per handoff, from the agent that handed work
 * over to the agent that took it. Every link is drawn at rest. No groups.
 */

export interface HandoffAgent {
  key: string;
  name: string;
  runs: number;
}

export interface HandoffNetwork {
  network: ToolNetworkModel;
  /** Link id to its handoff. */
  handoffs: ReadonlyMap<string, AgentHandoff>;
}

/** A link's strength floor, so a rare handoff still pulls its two agents together. */
const MIN_STRENGTH = 0.3;

export function handoffNetwork(
  agents: readonly HandoffAgent[],
  handoffs: readonly AgentHandoff[],
): HandoffNetwork {
  const nodes = new Map<string, NetworkNode>();
  const partners = new Map<string, Set<string>>();
  for (const agent of agents) nodes.set(agent.key, node(agent.key, agent.name, agent.runs));
  for (const edge of handoffs) {
    // An agent only seen as a caller or a callee (its own spans fall outside the list's cap) still gets a mark.
    if (!nodes.has(edge.from)) nodes.set(edge.from, node(edge.from, edge.fromName, 0));
    if (!nodes.has(edge.to)) nodes.set(edge.to, node(edge.to, edge.toName, 0));
    partners.set(edge.from, (partners.get(edge.from) ?? new Set()).add(edge.to));
    partners.set(edge.to, (partners.get(edge.to) ?? new Set()).add(edge.from));
  }
  const max = Math.max(1, ...handoffs.map((edge) => edge.count));
  const links: NetworkLink[] = [...handoffs]
    .sort((a, b) => b.count - a.count || linkId(a).localeCompare(linkId(b)))
    .map((edge) => ({
      id: linkId(edge),
      source: edge.from,
      target: edge.to,
      shared: [],
      steps: [],
      directed: true,
      strength: Math.max(MIN_STRENGTH, edge.count / max),
      backbone: true,
    }));
  const ordered = [...nodes.values()]
    .map((entry) => ({ ...entry, partners: partners.get(entry.id)?.size ?? 0 }))
    .sort((a, b) => b.calls - a.calls || a.id.localeCompare(b.id));
  return {
    network: { nodes: ordered, links, groups: [] },
    handoffs: new Map(handoffs.map((edge) => [linkId(edge), edge])),
  };
}

function node(id: string, name: string, calls: number): NetworkNode {
  return {
    id,
    kind: "tool",
    name,
    calls,
    asks: 0,
    missing: false,
    partners: 0,
    hub: false,
    group: null,
  };
}

function linkId(edge: AgentHandoff): string {
  return `${edge.from}|${edge.to}`;
}
