import { MAX_QUERY_CHARS } from "./contract";

/**
 * Deep links into the Playground.
 *
 * A calibration mismatch is the most common way in: the query is already known,
 * and so are the two rankings that disagreed on it. Carrying `selection` (rather
 * than only `q`) is what lets the Playground re-read the recorded arms and diff
 * a fresh run against them.
 */
export function playgroundHref(
  projectId: string,
  context: {
    query?: string | null;
    selectionId?: string | null;
    experimentName?: string | null;
  },
): string {
  const params = new URLSearchParams();
  const query = context.query?.trim();
  if (query) params.set("q", query.slice(0, MAX_QUERY_CHARS));
  if (context.selectionId) params.set("selection", context.selectionId);
  if (context.experimentName) params.set("experiment", context.experimentName);
  const search = params.toString();
  const base = `/project/${encodeURIComponent(projectId)}/playground`;
  return search ? `${base}?${search}` : base;
}
