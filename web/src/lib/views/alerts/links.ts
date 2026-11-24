import type { AlertQuery } from "@/lib/views/alerts/types";

/** The Alerts pages' addresses. */

/** The query a new alert starts from: a widget's, as JSON. */
export const NEW_ALERT_PARAM = "query";

export function alertsHref(projectId: string): string {
  return `/project/${encodeURIComponent(projectId)}/alerts`;
}

export function alertHref(projectId: string, ruleId: string): string {
  return `${alertsHref(projectId)}/${ruleId}`;
}

/** The empty form, or the form with a metric and its filter. */
export function newAlertHref(projectId: string, query?: AlertQuery): string {
  const path = `${alertsHref(projectId)}/new`;
  if (!query) return path;
  const { metric, aggregation, filter, scorerId } = query;
  const value = JSON.stringify({ metric, aggregation, filter, ...(scorerId ? { scorerId } : {}) });
  return `${path}?${new URLSearchParams({ [NEW_ALERT_PARAM]: value })}`;
}
