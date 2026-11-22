import { catalogEntryOf } from "@/lib/readings/trace-signals/self-corrections/issues";
import { DEFAULT_WINDOW_DAYS, type WindowDays } from "@/lib/readings/trace-signals/view";
import { capabilityCatalogHref } from "@/lib/views/intents/hrefs";

/**
 * Where Self-corrections and its neighbours live (the unified product plan):
 * this page and its filters, a task's page, a topic's panel on Intents, the
 * Fixes list, and a tool in Catalog. Every link is built here, so a route
 * that moves changes in one place.
 */

export interface SelfCorrectionFilters {
  /** A node id: a tool's catalog id, or `skill:<id>`. */
  tool: string | null;
  task: string | null;
  topic: string | null;
}

export const NO_FILTERS: SelfCorrectionFilters = { tool: null, task: null, topic: null };

const root = (projectId: string) => `/project/${encodeURIComponent(projectId)}`;

function withQuery(path: string, params: Record<string, string | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

/** This page, on a window and filters; the default window and no filters is the bare path. */
export function selfCorrectionsHref(
  projectId: string,
  options: { days?: WindowDays; filters?: Partial<SelfCorrectionFilters> } = {},
): string {
  const filters = { ...NO_FILTERS, ...options.filters };
  return withQuery(`${root(projectId)}/health/self-corrections`, {
    days: options.days && options.days !== DEFAULT_WINDOW_DAYS ? String(options.days) : null,
    tool: filters.tool,
    task: filters.task,
    topic: filters.topic,
  });
}

/** A task's page (Agent health, Tasks). */
export function taskHref(projectId: string, taskId: string): string {
  return `${root(projectId)}/health/tasks/${encodeURIComponent(taskId)}`;
}

/** A topic, opened in its panel on Intents. */
export function topicHref(projectId: string, topicId: string): string {
  return withQuery(`${root(projectId)}/intents`, { peek: topicId });
}

/** The Fixes list, narrowed to what a fix helps. */
export function fixesHref(projectId: string, scope: Partial<SelfCorrectionFilters> = {}): string {
  return withQuery(`${root(projectId)}/improvement/fixes`, {
    tool: scope.tool,
    task: scope.task,
    topic: scope.topic,
  });
}

/** A tool or skill in Catalog, from its node id. */
export function catalogHref(projectId: string, node: string): string {
  const entry = catalogEntryOf(node);
  return entry.kind === "skill"
    ? capabilityCatalogHref(projectId, "skill", entry.id, entry.id)
    : capabilityCatalogHref(projectId, "tool", entry.id);
}

/** The filters a page URL asks for; anything empty or repeated reads as its first value. */
export function parseFilters(
  search: Readonly<Record<string, string | readonly string[] | undefined>>,
): SelfCorrectionFilters {
  const first = (value: string | readonly string[] | undefined): string | null => {
    const raw = Array.isArray(value) ? value[0] : value;
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : null;
  };
  return { tool: first(search.tool), task: first(search.task), topic: first(search.topic) };
}
