import { legacyCraftPeek, legacyRewritePeek } from "@/lib/views/fixes/href";

/**
 * Pages the one-product redesign folded into others, answered in the proxy
 * with a permanent redirect, so an old link lands on its new home in one hop
 * (the page-level redirects stay as a fallback, but a `loading.tsx` above them
 * makes them answer 200 first). Pure: a URL in, a path or null out.
 *
 * Only moves that need nothing but the URL live here. Tool craft's `?ask=` and
 * `?peek=` are mapped to the task the ask's tools run as, which takes a
 * database read, so those stay with the page.
 */

const PROJECT_PATH =
  /^\/project\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/i;

/** Query parameters only the removed Intents and Suggestions tabs of the old index read. */
const RETIRED_INDEX_PARAMS = ["tab", "intentsPage", "intentsSort", "sstatus"];

export function movedPageDestination(url: Pick<URL, "pathname" | "searchParams">): string | null {
  const match = PROJECT_PATH.exec(url.pathname);
  if (!match) return null;
  const root = `/project/${match[1]}`;
  const rest = match[2] ?? "";
  const query = url.searchParams;

  switch (rest) {
    case "/improvement": {
      const kept = new URLSearchParams(query);
      for (const key of RETIRED_INDEX_PARAMS) kept.delete(key);
      return withQuery(`${root}/improvement/fixes`, kept);
    }
    // Match quality's score and rewrites live on Quality › Descriptions.
    case "/improvement/match-quality":
      return `${root}/quality/descriptions`;
    case "/quality/suggestions":
      return withParams(`${root}/quality/descriptions`, {
        peek: legacyRewritePeek(query.get("peek") ?? undefined),
      });
    case "/improvement/tool-explorer/suggestions":
      return withParams(`${root}/improvement/fixes`, {
        peek: legacyCraftPeek(query.get("peek") ?? undefined),
      });
    case "/improvement/tool-explorer":
      if (query.has("ask") || query.has("peek")) return null;
      return query.get("view") === "crafts" ? `${root}/improvement/fixes` : `${root}/health/tasks`;
    case "/intents/asks":
      return withParams(`${root}/intents`, { peek: query.get("peek") });
    case "/dashboards":
      return `${root}?peek=context`;
    case "/runtime-events":
      return withQuery(`${root}/settings/developer`, query);
  }

  const session = /^\/improvement\/tool-explorer\/sessions\/([^/]+)$/.exec(rest);
  if (session)
    return withParams(`${root}/health/tasks/sessions/${session[1]}`, { tools: query.get("tools") });
  return null;
}

function withParams(path: string, params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  return withQuery(path, search);
}

function withQuery(path: string, search: URLSearchParams): string {
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}
