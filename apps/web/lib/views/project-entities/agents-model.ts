/**
 * The Agents pages' view model (RP-28, the approved RP-25 design). Pure: the
 * pages read the rows and the handoffs, and this module decides the tree, the
 * order, the error pill, the tool groups and the handoff map's layout.
 */

/** An agent's error rate above this shows a red pill in the list and a red box in the map. */
export const AGENT_ERROR_PILL_RATE = 0.1;
/** Built-in tools kept as their own rows; the rest fold into one "+n more" row. */
export const BUILT_IN_TOOLS_SHOWN = 5;

export interface AgentListEntry {
  key: string;
  displayName: string;
  calls: number;
  errors: number;
  errorRate: number;
  costUsd: number;
  p95Ms: number;
  /** ISO. */
  lastSeenAt: string;
}

export interface Handoff {
  from: string;
  to: string;
  fromName: string;
  toName: string;
  count: number;
}

export type AgentRole = "entry" | "sub-agent";

export interface AgentTreeRow<T extends AgentListEntry = AgentListEntry> {
  agent: T;
  /** 0 for an entry agent; its sub-agents one deeper. Always 0 in a sorted (flat) list. */
  depth: number;
  /** Null when the project has no handoff: a role means nothing then. */
  role: AgentRole | null;
  /** The busiest caller: the row this one nests under. */
  parent: { key: string; name: string; count: number } | null;
  /** The agents this one hands work to, busiest first. */
  callees: string[];
}

export type AgentSortColumn = "name" | "runs" | "cost" | "errorRate" | "p95" | "lastSeen";
export type AgentSort = { id: AgentSortColumn; direction: "asc" | "desc" };

/**
 * The list as a tree: each agent nests under its busiest caller, entry agents
 * (no parent) first by runs, each followed by its sub-agents by runs. A
 * handoff that would close a loop does not nest.
 */
export function agentTree<T extends AgentListEntry>(
  agents: readonly T[],
  handoffs: readonly Handoff[],
): AgentTreeRow<T>[] {
  const byKey = new Map(agents.map((agent) => [agent.key, agent]));
  const listed = handoffs.filter((edge) => byKey.has(edge.from) && byKey.has(edge.to));
  const parents = nestingParents(listed);
  const children = new Map<string, T[]>();
  for (const [child, parent] of parents) {
    const agent = byKey.get(child);
    if (agent) children.set(parent.from, [...(children.get(parent.from) ?? []), agent]);
  }
  const hasHandoffs = listed.length > 0;
  const called = new Set(listed.map((edge) => edge.to));
  const rows: AgentTreeRow<T>[] = [];
  const visit = (agent: T, depth: number) => {
    const parent = parents.get(agent.key);
    rows.push({
      agent,
      depth,
      role: hasHandoffs ? (called.has(agent.key) ? "sub-agent" : "entry") : null,
      parent: parent ? { key: parent.from, name: parent.fromName, count: parent.count } : null,
      callees: listed
        .filter((edge) => edge.from === agent.key)
        .sort((a, b) => b.count - a.count)
        .map((edge) => edge.toName),
    });
    for (const child of byRuns(children.get(agent.key) ?? [])) visit(child, depth + 1);
  };
  for (const root of byRuns(agents.filter((agent) => !parents.has(agent.key)))) visit(root, 0);
  return rows;
}

/** The rows to draw: the tree with no sort; a flat list by the column with one. */
export function sortAgentRows<T extends AgentListEntry>(
  tree: readonly AgentTreeRow<T>[],
  sort: AgentSort | null,
): AgentTreeRow<T>[] {
  if (!sort) return [...tree];
  const value = SORT_VALUES[sort.id];
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...tree]
    .sort((a, b) => {
      const left = value(a.agent);
      const right = value(b.agent);
      const order =
        typeof left === "string" && typeof right === "string"
          ? left.localeCompare(right)
          : Number(left) - Number(right);
      return sign * order || a.agent.key.localeCompare(b.agent.key);
    })
    .map((row) => ({ ...row, depth: 0 }));
}

/** Whether the agent's error rate earns the red pill. */
export function agentErrorPill(errorRate: number): boolean {
  return errorRate > AGENT_ERROR_PILL_RATE;
}

/** The longest handoff chain from the busiest entry agent, as names: "claude → Explore → Plan". */
export function handoffChain(tree: readonly AgentTreeRow[]): string[] {
  let best: string[] = [];
  const path: string[] = [];
  for (const row of tree) {
    path.length = row.depth;
    path.push(row.agent.displayName);
    if (path.length > best.length) best = [...path];
  }
  return best.length > 1 ? best : [];
}

export interface AgentToolEntry {
  /** The name without its `mcp__<server>__` prefix. */
  tool: string;
  /** Null: a built-in tool. */
  server: string | null;
  calls: number;
  errors: number;
  errorRate: number;
  p95Ms: number;
  /** The newest failed call's `error.type`. */
  lastError: string | null;
}

export type AgentToolRow =
  | { kind: "tool"; tool: AgentToolEntry }
  | { kind: "folded"; tools: string[]; calls: number; errors: number; p95Ms: number };

export interface AgentToolGroup {
  /** Null: the built-in tools. */
  server: string | null;
  calls: number;
  errors: number;
  rows: AgentToolRow[];
}

/**
 * The agent's tools grouped by source: each MCP server, busiest first, then
 * the built-in tools. Built-in tools past the busiest few that never failed
 * fold into one row.
 */
export function groupAgentTools(
  tools: readonly AgentToolEntry[],
  shown: number = BUILT_IN_TOOLS_SHOWN,
): AgentToolGroup[] {
  const servers = new Map<string, AgentToolEntry[]>();
  const builtIn: AgentToolEntry[] = [];
  for (const tool of tools) {
    if (tool.server) servers.set(tool.server, [...(servers.get(tool.server) ?? []), tool]);
    else builtIn.push(tool);
  }
  const groups: AgentToolGroup[] = [...servers]
    .map(([server, rows]) => ({
      server,
      ...totals(rows),
      rows: byCalls(rows).map((tool): AgentToolRow => ({ kind: "tool", tool })),
    }))
    .sort((a, b) => b.calls - a.calls || String(a.server).localeCompare(String(b.server)));
  if (builtIn.length === 0) return groups;
  const ordered = byCalls(builtIn);
  const kept = ordered.filter((tool, index) => index < shown || tool.errors > 0);
  const rest = ordered.filter((tool) => !kept.includes(tool));
  const rows: AgentToolRow[] = (rest.length > 1 ? kept : ordered).map((tool) => ({
    kind: "tool",
    tool,
  }));
  if (rest.length > 1) {
    rows.push({
      kind: "folded",
      tools: rest.map((tool) => tool.tool),
      calls: rest.reduce((sum, tool) => sum + tool.calls, 0),
      errors: rest.reduce((sum, tool) => sum + tool.errors, 0),
      p95Ms: Math.max(...rest.map((tool) => tool.p95Ms)),
    });
  }
  return [...groups, { server: null, ...totals(builtIn), rows }];
}

export interface MapNode {
  key: string;
  name: string;
  runs: number;
  failing: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MapEdge {
  from: string;
  to: string;
  count: number;
  /** Stroke width in px. */
  width: number;
}

export interface HandoffMapLayout {
  nodes: MapNode[];
  edges: MapEdge[];
  width: number;
  height: number;
}

const MAP = {
  columnGap: 36,
  rowGap: 20,
  minWidth: 60,
  maxWidth: 100,
  minHeight: 32,
  maxHeight: 44,
  minStroke: 1,
  maxStroke: 6,
  padding: 8,
} as const;

/**
 * The handoff map, left to right: a column per tree depth, an agent's box
 * sized by its runs, an edge's width by its handoffs, a box red past the error
 * pill rate. Empty with no handoff: the page hides the card then.
 */
export function handoffMapLayout(
  tree: readonly AgentTreeRow[],
  handoffs: readonly Handoff[],
): HandoffMapLayout {
  const keys = new Set(tree.map((row) => row.agent.key));
  const edges = handoffs.filter((edge) => keys.has(edge.from) && keys.has(edge.to));
  if (edges.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };
  const linked = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  const rows = tree.filter((row) => linked.has(row.agent.key));
  const maxRuns = Math.max(1, ...rows.map((row) => row.agent.calls));
  const maxCount = Math.max(1, ...edges.map((edge) => edge.count));
  const columns: AgentTreeRow[][] = [];
  for (const row of rows) {
    columns[row.depth] = [...(columns[row.depth] ?? []), row];
  }
  const sized = columns.map((column) =>
    (column ?? []).map((row) => {
      const share = row.agent.calls / maxRuns;
      return {
        row,
        width: Math.round(MAP.minWidth + (MAP.maxWidth - MAP.minWidth) * share),
        height: Math.round(MAP.minHeight + (MAP.maxHeight - MAP.minHeight) * share),
      };
    }),
  );
  const columnWidth = sized.map((column) => Math.max(0, ...column.map((cell) => cell.width)));
  const columnHeight = sized.map(
    (column) =>
      column.reduce((sum, cell) => sum + cell.height, 0) + MAP.rowGap * (column.length - 1),
  );
  const height = Math.max(...columnHeight) + MAP.padding * 2;
  const nodes: MapNode[] = [];
  let x = MAP.padding;
  sized.forEach((column, depth) => {
    let y = (height - columnHeight[depth]) / 2;
    for (const cell of column) {
      nodes.push({
        key: cell.row.agent.key,
        name: cell.row.agent.displayName,
        runs: cell.row.agent.calls,
        failing: agentErrorPill(cell.row.agent.errorRate),
        x: x + (columnWidth[depth] - cell.width) / 2,
        y,
        width: cell.width,
        height: cell.height,
      });
      y += cell.height + MAP.rowGap;
    }
    x += columnWidth[depth] + MAP.columnGap;
  });
  return {
    nodes,
    edges: edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      count: edge.count,
      width:
        Math.round(
          (MAP.minStroke + (MAP.maxStroke - MAP.minStroke) * (edge.count / maxCount)) * 10,
        ) / 10,
    })),
    width: x - MAP.columnGap + MAP.padding,
    height,
  };
}

// — Helpers ——————————————————————————————————————————————————————————————————

const SORT_VALUES: Record<AgentSortColumn, (agent: AgentListEntry) => string | number> = {
  name: (agent) => agent.displayName.toLowerCase(),
  runs: (agent) => agent.calls,
  cost: (agent) => agent.costUsd,
  errorRate: (agent) => agent.errorRate,
  p95: (agent) => agent.p95Ms,
  lastSeen: (agent) => Date.parse(agent.lastSeenAt),
};

/** Each agent's busiest caller, taken busiest handoff first, skipping one that closes a loop. */
function nestingParents(handoffs: readonly Handoff[]): Map<string, Handoff> {
  const parents = new Map<string, Handoff>();
  const ordered = [...handoffs].sort(
    (a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
  for (const edge of ordered) {
    if (parents.has(edge.to) || closesLoop(parents, edge)) continue;
    parents.set(edge.to, edge);
  }
  return parents;
}

function closesLoop(parents: ReadonlyMap<string, Handoff>, edge: Handoff): boolean {
  let at: string | undefined = edge.from;
  while (at !== undefined) {
    if (at === edge.to) return true;
    at = parents.get(at)?.from;
  }
  return false;
}

function byRuns<T extends AgentListEntry>(agents: readonly T[]): T[] {
  return [...agents].sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key));
}

function byCalls(tools: readonly AgentToolEntry[]): AgentToolEntry[] {
  return [...tools].sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
}

function totals(tools: readonly AgentToolEntry[]): { calls: number; errors: number } {
  return {
    calls: tools.reduce((sum, tool) => sum + tool.calls, 0),
    errors: tools.reduce((sum, tool) => sum + tool.errors, 0),
  };
}
