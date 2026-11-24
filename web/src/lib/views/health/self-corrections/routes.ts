import { selfCorrectionsHref } from "@/lib/views/health/self-corrections/paths";

type Query = Readonly<Record<string, string | readonly string[] | undefined>>;

/** Where a link to the page's Agent health address goes now: the Insights page, with the whole query. */
export function movedSelfCorrectionsHref(projectId: string, query: Query = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) search.append(key, item);
    }
  }
  const path = selfCorrectionsHref(projectId);
  return search.size > 0 ? `${path}?${search}` : path;
}
