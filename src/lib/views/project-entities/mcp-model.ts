/**
 * The MCP servers pages' view model (RP-28, the approved RP-25 design): a
 * server's status from fixed thresholds, the list's default order, when the
 * "Seen from" column earns its place, and how a latency reads on a small
 * sample. Pure.
 */

/** A server at or above this error rate is failing. */
export const MCP_FAILING_RATE = 0.5;
/** A server at or above this error rate (and below failing) is degraded. */
export const MCP_DEGRADED_RATE = 0.05;
/** Fewer calls than this: a p50 next to the p95 says little, so the KPI says the sample size. */
export const MCP_SMALL_SAMPLE = 20;

export type McpStatus = "failing" | "degraded" | "healthy";

export interface McpListEntry {
  key: string;
  role: string;
  calls: number;
  errorRate: number;
}

export type McpSortColumn =
  | "name"
  | "status"
  | "calls"
  | "errorRate"
  | "p95"
  | "tools"
  | "agents"
  | "lastSeen";
export type McpSort = { id: McpSortColumn; direction: "asc" | "desc" };

/** The server's status from its error rate. */
export function mcpStatus(errorRate: number): McpStatus {
  if (errorRate >= MCP_FAILING_RATE) return "failing";
  if (errorRate >= MCP_DEGRADED_RATE) return "degraded";
  return "healthy";
}

/** The list's default order: failing first, then degraded, then healthy; busiest first within each. */
export function sortMcpServers<T extends McpListEntry>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      STATUS_RANK[mcpStatus(a.errorRate)] - STATUS_RANK[mcpStatus(b.errorRate)] ||
      b.calls - a.calls ||
      a.key.localeCompare(b.key) ||
      a.role.localeCompare(b.role),
  );
}

/**
 * One row per server, for totals: a server seen from both sides (its agents' calls and its own
 * spans) is the same calls twice, so it keeps its busiest side, as the detail page does.
 */
export function onePerServer<T extends McpListEntry>(rows: readonly T[]): T[] {
  const busiest = new Map<string, T>();
  for (const row of rows) {
    const kept = busiest.get(row.key);
    if (!kept || row.calls > kept.calls) busiest.set(row.key, row);
  }
  return [...busiest.values()];
}

/** The rank of a status in the default order: failing 0, degraded 1, healthy 2. */
export function statusRank(errorRate: number): number {
  return STATUS_RANK[mcpStatus(errorRate)];
}

/** "Seen from" is a column only when the rows differ: one side for every row says nothing. */
export function showSeenFrom(rows: readonly { role: string }[]): boolean {
  return new Set(rows.map((row) => row.role)).size > 1;
}

/** What sits next to the p95: the p50 on a fair sample, else the sample size. */
export function latencyHint(calls: number, p50Ms: number, format: (ms: number) => string): string {
  return calls < MCP_SMALL_SAMPLE ? `n = ${calls}` : `p50 ${format(p50Ms)}`;
}

/** Which tool the errors come from, for the error rate KPI: "all task_update", "most in task_update", "2 tools". */
export function failingToolsHint(
  tools: readonly { tool: string; errors: number }[],
): string | null {
  const failing = tools.filter((tool) => tool.errors > 0).sort((a, b) => b.errors - a.errors);
  if (failing.length === 0) return null;
  if (failing.length === 1) return `all ${failing[0].tool}`;
  const total = failing.reduce((sum, tool) => sum + tool.errors, 0);
  return failing[0].errors * 2 > total ? `most in ${failing[0].tool}` : `${failing.length} tools`;
}

const STATUS_RANK: Record<McpStatus, number> = { failing: 0, degraded: 1, healthy: 2 };
