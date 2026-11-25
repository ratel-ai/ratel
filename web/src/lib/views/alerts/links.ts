import { MAX_FILTER_BYTES } from "@/lib/contracts/filter-budget";
import type { MetricQuery } from "@/lib/contracts/query";
import { pack, unpack } from "@/lib/synthesis/traces/compact-json";
import { MAX_SEARCH_CHARS } from "@/lib/views/dashboards/filters";

/** The Alerts pages' addresses. */

/** The query a new alert starts from: a widget's, packed. */
export const NEW_ALERT_PARAM = "query";
/** The query has the filters of the page it comes from. */
export const PAGE_FILTERS_PARAM = "pageFilters";

export function alertsHref(projectId: string): string {
  return `/project/${encodeURIComponent(projectId)}/alerts`;
}

export function alertHref(projectId: string, ruleId: string): string {
  return `${alertsHref(projectId)}/${ruleId}`;
}

/** The parameter's value while the query is in the fragment, which no request carries. */
export const IN_FRAGMENT = "hash";
const MAX_QUERY_JSON = MAX_FILTER_BYTES + 1_000;

/** The empty form, or the form with a query, ungrouped. A long query is in the fragment. */
export function newAlertHref(projectId: string, query?: MetricQuery, pageFilters = false): string {
  const path = `${alertsHref(projectId)}/new`;
  if (!query) return path;
  const value = pack({ ...query, dimensions: [], bucket: undefined });
  const params = new URLSearchParams({ [NEW_ALERT_PARAM]: value });
  if (pageFilters) params.set(PAGE_FILTERS_PARAM, "1");
  const href = `${path}?${params}`;
  if (href.length <= MAX_SEARCH_CHARS) return href;
  params.set(NEW_ALERT_PARAM, IN_FRAGMENT);
  return `${path}?${params}#${value}`;
}

/** The query of a link, unchecked: packed, or the JSON of links before it. */
export function alertQueryOf(value: string): unknown {
  if (!value.startsWith("{")) return unpack(value, MAX_QUERY_JSON);
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
