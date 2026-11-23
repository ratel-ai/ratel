import { type FixKind, parseFixKind } from "@/lib/views/fixes/kinds";

/**
 * Where Fixes lives and how other pages point into it: the list, a filter
 * (`?kind=`, `?task=`, `?tool=`, `?topic=`) and an open fix (`?peek=`), plus
 * the neighbours a fix links back to. Pure and client-safe, so any page can
 * build a link without loading anything.
 */

type Query = Readonly<Record<string, string | readonly string[] | undefined>>;

export function fixesRoot(projectId: string): string {
  return `/project/${encodeURIComponent(projectId)}/improvement/fixes`;
}

export interface FixFilters {
  kind: FixKind | null;
  /** A task id (Agent health's workflow id). */
  task: string | null;
  /** A catalog tool id. */
  tool: string | null;
  /** An intent id (Intents; `lib/topics` in code, hence the parameter's name). */
  topic: string | null;
}

export const NO_FILTERS: FixFilters = { kind: null, task: null, tool: null, topic: null };

/** The list, filtered and with a fix open: every part optional. */
export function fixHref(
  projectId: string,
  opts: {
    kind?: FixKind | null;
    task?: string | null;
    tool?: string | null;
    topic?: string | null;
    peek?: string | null;
  } = {},
): string {
  const params = new URLSearchParams();
  for (const key of ["kind", "task", "tool", "topic", "peek"] as const) {
    const value = opts[key];
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `${fixesRoot(projectId)}?${query}` : fixesRoot(projectId);
}

function first(raw: string | readonly string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseFixFilters(query: Query): FixFilters {
  return {
    kind: parseFixKind(query.kind),
    task: first(query.task),
    tool: first(query.tool),
    topic: first(query.topic),
  };
}

export function hasFilters(filters: FixFilters): boolean {
  return (
    filters.kind !== null ||
    filters.task !== null ||
    filters.tool !== null ||
    filters.topic !== null
  );
}

/** The issue on Agent health: its card opens itself when the anchor is targeted. */
export function issueHref(projectId: string, issueId: string): string {
  return `/project/${encodeURIComponent(projectId)}/health#signal-${issueId}`;
}

/** A task's page (Agent health, Tasks). */
export function taskHref(projectId: string, taskId: string): string {
  return `/project/${encodeURIComponent(projectId)}/health/tasks/${encodeURIComponent(taskId)}`;
}

/** A topic, open in its panel on Intents. */
export function topicHref(projectId: string, topicId: string): string {
  return `/project/${encodeURIComponent(projectId)}/intents?peek=${encodeURIComponent(topicId)}`;
}

/** A tool, open on Catalog's Tools page (`?highlight=` opens it when it is there). */
export function catalogToolHref(projectId: string, toolName: string): string {
  return `/project/${encodeURIComponent(projectId)}/catalogs/tools?highlight=${encodeURIComponent(toolName)}`;
}

/**
 * Quality › Descriptions, the page where a searchable description is updated
 * and a rewrite applied: the rewrite open when there is one
 * (`?peek=rewrite:<id>`), else the tool (`?tool=<id>`), else the page. Fixes,
 * Agent health and the Overview send a description fix here.
 */
export function descriptionHref(
  projectId: string,
  target: { rewriteId?: string | null; toolId?: string | null } = {},
): string {
  const root = `/project/${encodeURIComponent(projectId)}/quality/descriptions`;
  if (target.rewriteId) return `${root}?peek=${encodeURIComponent(`rewrite:${target.rewriteId}`)}`;
  if (target.toolId) return `${root}?tool=${encodeURIComponent(target.toolId)}`;
  return root;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An old Tool craft Suggestions `?peek=` (a draft's id) as the fix it became. */
export function legacyCraftPeek(raw: string | readonly string[] | undefined): string | null {
  const value = first(raw);
  return value && UUID.test(value) ? `craft:${value}` : null;
}

/** An old Quality Suggestions `?peek=` (a rewrite's id) as the fix it became. */
export function legacyRewritePeek(raw: string | readonly string[] | undefined): string | null {
  const value = first(raw);
  return value && UUID.test(value) ? `rewrite:${value}` : null;
}
