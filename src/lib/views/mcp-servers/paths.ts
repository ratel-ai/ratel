import { projectRoot } from "@/lib/console/navigation";
import type { McpRole } from "@/lib/ingest/otlp/dimensions";

/**
 * The URLs of the MCP servers pages (RC-777) and of the pages they link to.
 * The window (`range`, `from`, `to`) and the environment (`facetEnvironment`,
 * the parameter Traces reads) travel with every link, so a drill-down shows
 * the same calls.
 */

export interface McpServersQuery {
  range?: string;
  from?: string;
  to?: string;
  environment?: string | null;
}

export const MCP_ENVIRONMENT_PARAM = "facetEnvironment";
export const MCP_ROLE_PARAM = "role";
const ROLES: readonly McpRole[] = ["provided", "consumed"];

/** The list page. */
export function mcpServersHref(projectId: string, query: McpServersQuery = {}): string {
  return withQuery(`${projectRoot(projectId)}/mcp`, windowParams(query));
}

/** One server's page: the key is one path segment, the role a query parameter. */
export function mcpServerHref(
  projectId: string,
  key: string,
  query: McpServersQuery & { role?: McpRole } = {},
): string {
  return withQuery(`${projectRoot(projectId)}/mcp/${encodeURIComponent(key)}`, [
    ...(query.role ? [[MCP_ROLE_PARAM, query.role] as const] : []),
    ...windowParams(query),
  ]);
}

/** The server's key from its path segment. */
export function parseMcpServerKey(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parseMcpRole(value: string | string[] | undefined): McpRole | undefined {
  const role = Array.isArray(value) ? value[0] : value;
  return ROLES.find((candidate) => candidate === role);
}

/** Traces' Turns, filtered by the server (RC-790 `facetServer`). */
export function mcpServerTracesHref(
  projectId: string,
  key: string,
  query: McpServersQuery = {},
): string {
  return withQuery(`${projectRoot(projectId)}/traces/turns`, [
    ["facetServer", key],
    ...windowParams(query),
  ]);
}

/**
 * Traces' sessions list, filtered by a caller country (`facetCountry`, the
 * Traces facet) and by the server the Clients tab shows, if any (RC-1058).
 */
export function mcpCountryTracesHref(
  projectId: string,
  country: string,
  query: McpServersQuery & { server?: string | null } = {},
): string {
  return withQuery(`${projectRoot(projectId)}/traces`, [
    ["facetCountry", country.toUpperCase()],
    ...(query.server ? [["facetServer", query.server] as const] : []),
    ...windowParams(query),
  ]);
}

export const MCP_TAB_PARAM = "tab";
export const MCP_CLIENTS_TAB = "clients";
export const MCP_SERVER_PARAM = "server";

/** The Clients tab of the MCP page (RC-778), optionally filtered by one server. */
export function mcpClientsHref(
  projectId: string,
  query: McpServersQuery & { server?: string | null } = {},
): string {
  return withQuery(`${projectRoot(projectId)}/mcp`, [
    [MCP_TAB_PARAM, MCP_CLIENTS_TAB],
    ...(query.server ? [[MCP_SERVER_PARAM, query.server] as const] : []),
    ...windowParams(query),
  ]);
}

/** The Clients tab, filtered by the server. */
export function mcpServerClientsHref(
  projectId: string,
  key: string,
  query: McpServersQuery = {},
): string {
  return mcpClientsHref(projectId, { ...query, server: key });
}

/**
 * The Catalog, searched for the server: its search keeps a tool group whose
 * label matches, and the group label of an MCP server's tools is the server
 * (`toolGroupLabels` in `lib/catalog/v2/tree.ts`).
 */
export function mcpServerCatalogHref(projectId: string, key: string): string {
  return withQuery(`${projectRoot(projectId)}/catalogs`, [["q", key]]);
}

function windowParams(query: McpServersQuery): (readonly [string, string])[] {
  const pairs: (readonly [string, string | null | undefined])[] = [
    ["range", query.range],
    ["from", query.from],
    ["to", query.to],
    [MCP_ENVIRONMENT_PARAM, query.environment],
  ];
  return pairs.filter((pair): pair is readonly [string, string] => Boolean(pair[1]));
}

function withQuery(path: string, pairs: readonly (readonly [string, string])[]): string {
  if (pairs.length === 0) return path;
  const params = new URLSearchParams(pairs.map(([key, value]) => [key, value]));
  return `${path}?${params.toString().replace(/\+/g, "%20")}`;
}
