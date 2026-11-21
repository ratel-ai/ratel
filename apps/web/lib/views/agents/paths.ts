import { projectRoot } from "@/lib/console/navigation";

/**
 * The URLs of the Agents pages (RC-775) and of the pages they link to. The
 * window (`range`, `from`, `to`) and the environment (`facetEnvironment`, the
 * parameter Traces reads) travel with every link, so a drill-down shows the
 * same runs.
 */

export interface AgentsQuery {
  range?: string;
  from?: string;
  to?: string;
  environment?: string | null;
}

export const AGENTS_ENVIRONMENT_PARAM = "facetEnvironment";
/** `1`: the list shows hidden agents too (RC-776). */
export const AGENTS_SHOW_HIDDEN_PARAM = "showHidden";

/** The list page. */
export function agentsHref(projectId: string, query: AgentsQuery = {}): string {
  return withQuery(`${projectRoot(projectId)}/agents`, windowParams(query));
}

/** One agent's page: the key is one path segment. */
export function agentHref(projectId: string, key: string, query: AgentsQuery = {}): string {
  return withQuery(
    `${projectRoot(projectId)}/agents/${encodeURIComponent(key)}`,
    windowParams(query),
  );
}

/** The override write route (RC-776). */
export function agentOverridesApiHref(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/agents/overrides`;
}

/** The agent's key from its path segment. */
export function parseAgentKey(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Traces' Turns, filtered by the agent (RC-790 `facetAgent`): a merged agent passes every key merged into it. */
export function agentTracesHref(
  projectId: string,
  key: string | readonly string[],
  query: AgentsQuery = {},
): string {
  const keys = typeof key === "string" ? [key] : key;
  return withQuery(`${projectRoot(projectId)}/traces/turns`, [
    ...keys.map((each) => ["facetAgent", each] as const),
    ...windowParams(query),
  ]);
}

function windowParams(query: AgentsQuery): (readonly [string, string])[] {
  const pairs: (readonly [string, string | null | undefined])[] = [
    ["range", query.range],
    ["from", query.from],
    ["to", query.to],
    [AGENTS_ENVIRONMENT_PARAM, query.environment],
  ];
  return pairs.filter((pair): pair is readonly [string, string] => Boolean(pair[1]));
}

function withQuery(path: string, pairs: readonly (readonly [string, string])[]): string {
  if (pairs.length === 0) return path;
  const params = new URLSearchParams(pairs.map(([key, value]) => [key, value]));
  return `${path}?${params.toString().replace(/\+/g, "%20")}`;
}
